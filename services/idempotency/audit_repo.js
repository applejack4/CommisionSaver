const crypto = require('crypto');
const { getDatabase } = require('../../database');

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
        db.get(
          `SELECT status, response_snapshot
           FROM audit_events
           WHERE source = ? AND event_type = ? AND idempotency_key = ?
           LIMIT 1`,
          [source, eventType, idempotencyKey],
          (selectErr, row) => {
            if (selectErr) {
              reject(selectErr);
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
  markFailed
};
