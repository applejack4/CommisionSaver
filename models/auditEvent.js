const { getDatabase } = require('../database');

async function create(eventData) {
  const db = await getDatabase();
  const {
    event_type,
    session_id = null,
    operator_id = null,
    takeover_id = null,
    idempotency_key = null,
    payload = null
  } = eventData;

  const payloadValue = payload ? JSON.stringify(payload) : null;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO audit_events
       (event_type, session_id, operator_id, takeover_id, idempotency_key, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [event_type, session_id, operator_id, takeover_id, idempotency_key, payloadValue],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        findById(this.lastID)
          .then(resolve)
          .catch(reject);
      }
    );
  });
}

async function findById(id) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM audit_events WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      }
    );
  });
}

async function findByIdempotencyKey(sessionId, idempotencyKey, eventType) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM audit_events
       WHERE session_id = ? AND idempotency_key = ? AND event_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sessionId, idempotencyKey, eventType],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      }
    );
  });
}

module.exports = {
  create,
  findById,
  findByIdempotencyKey
};
