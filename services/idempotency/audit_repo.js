const crypto = require('crypto');
const { getDatabase } = require('../../database');

const STARTED_TTL_SECONDS = Number.parseInt(
  process.env.IDEMPOTENCY_STARTED_TTL_SECONDS || '300', 10
);

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function parseSnapshot(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function serializeSnapshot(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

/**
 * Attempt to take over a 'started' row that has been stuck longer than
 * STARTED_TTL_SECONDS.  Uses an atomic UPDATE with a WHERE guard so only
 * one caller wins the takeover race.
 *
 * Returns { id } on success, null if the row is not stale enough or was
 * already taken over by another caller.
 */
function tryTakeoverStale(db, { source, eventType, idempotencyKey }) {
  return new Promise((resolve, reject) => {
    const ttlClause = `-${STARTED_TTL_SECONDS} seconds`;
    db.run(
      `UPDATE audit_events
       SET created_at = datetime('now'),
           response_snapshot = NULL,
           error_snapshot = NULL,
           completed_at = NULL
       WHERE source = ? AND event_type = ? AND idempotency_key = ?
         AND status = 'started'
         AND created_at <= datetime('now', ?)`,
      [source, eventType, idempotencyKey, ttlClause],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        if (this.changes === 0) {
          resolve(null);
          return;
        }
        // Took over — fetch the id so the caller can markCompleted/markFailed.
        db.get(
          `SELECT id FROM audit_events
           WHERE source = ? AND event_type = ? AND idempotency_key = ?
           LIMIT 1`,
          [source, eventType, idempotencyKey],
          (selectErr, row) => {
            if (selectErr) {
              reject(selectErr);
              return;
            }
            resolve(row ? { id: row.id } : null);
          }
        );
      }
    );
  });
}

async function tryInsert({ source, eventType, idempotencyKey, requestHash }) {
  const db = await getDatabase();
  const id = createId();
  const status = 'started';

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO audit_events
        (id, source, event_type, idempotency_key, status, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [id, source, eventType, idempotencyKey, status, requestHash],
      function (err) {
        if (!err) {
          resolve({ inserted: true, id, status });
          return;
        }
        if (err.code !== 'SQLITE_CONSTRAINT') {
          reject(err);
          return;
        }
        // Duplicate key — inspect existing row.
        db.get(
          `SELECT id, status, response_snapshot, created_at
           FROM audit_events
           WHERE source = ? AND event_type = ? AND idempotency_key = ?
           LIMIT 1`,
          [source, eventType, idempotencyKey],
          (selectErr, row) => {
            if (selectErr) {
              reject(selectErr);
              return;
            }

            // If the row is stuck in 'started', try a TTL-based takeover.
            if (row?.status === 'started') {
              tryTakeoverStale(db, { source, eventType, idempotencyKey })
                .then((takeover) => {
                  if (takeover) {
                    resolve({
                      inserted: true,
                      id: takeover.id,
                      status: 'started',
                      takenOver: true
                    });
                  } else {
                    // Row is 'started' but not stale — still in progress.
                    resolve({
                      inserted: false,
                      status: row.status,
                      response_snapshot: parseSnapshot(row.response_snapshot ?? null)
                    });
                  }
                })
                .catch(reject);
              return;
            }

            resolve({
              inserted: false,
              status: row?.status || null,
              response_snapshot: parseSnapshot(row?.response_snapshot ?? null)
            });
          }
        );
      }
    );
  });
}

async function markCompleted(id, response) {
  const db = await getDatabase();
  const snapshot = serializeSnapshot(response);

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE audit_events
       SET status = ?, response_snapshot = ?, completed_at = datetime('now')
       WHERE id = ?`,
      ['completed', snapshot, id],
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}

async function markFailed(id, error) {
  const db = await getDatabase();
  const snapshot = serializeSnapshot({
    name: error?.name,
    message: error?.message,
    stack: error?.stack
  });

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE audit_events
       SET status = ?, error_snapshot = ?, completed_at = datetime('now')
       WHERE id = ?`,
      ['failed', snapshot, id],
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}

module.exports = {
  tryInsert,
  markCompleted,
  markFailed,
  STARTED_TTL_SECONDS
};
