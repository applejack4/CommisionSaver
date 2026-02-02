const { getDatabase } = require('../database');

async function createTakeover(takeoverData) {
  const db = await getDatabase();
  const {
    session_id,
    booking_id = null,
    operator_id,
    reason = null
  } = takeoverData;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO operator_takeovers
       (session_id, booking_id, operator_id, status, reason, started_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, datetime('now'))`,
      [session_id, booking_id, operator_id, reason],
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
      'SELECT * FROM operator_takeovers WHERE id = ?',
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

async function findActiveBySession(sessionId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM operator_takeovers
       WHERE session_id = ? AND status = 'ACTIVE'
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [sessionId],
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

async function findLatestBySession(sessionId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM operator_takeovers
       WHERE session_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [sessionId],
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

async function findLatestBySessionIds(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) {
    return new Map();
  }
  const db = await getDatabase();
  const placeholders = sessionIds.map(() => '?').join(',');

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT ot.*
       FROM operator_takeovers ot
       JOIN (
         SELECT session_id, MAX(id) AS max_id
         FROM operator_takeovers
         WHERE session_id IN (${placeholders})
         GROUP BY session_id
       ) latest
       ON ot.session_id = latest.session_id AND ot.id = latest.max_id`,
      sessionIds,
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        const map = new Map();
        (rows || []).forEach(row => {
          map.set(row.session_id, row);
        });
        resolve(map);
      }
    );
  });
}

async function findActiveBySessionIds(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) {
    return new Map();
  }
  const db = await getDatabase();
  const placeholders = sessionIds.map(() => '?').join(',');

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM operator_takeovers
       WHERE session_id IN (${placeholders}) AND status = 'ACTIVE'`,
      sessionIds,
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        const map = new Map();
        (rows || []).forEach(row => {
          map.set(row.session_id, row);
        });
        resolve(map);
      }
    );
  });
}

async function releaseTakeover(takeoverId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE operator_takeovers
       SET status = 'RELEASED', ended_at = datetime('now')
       WHERE id = ? AND status = 'ACTIVE'`,
      [takeoverId],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        if (this.changes === 0) {
          resolve(null);
          return;
        }
        findById(takeoverId)
          .then(resolve)
          .catch(reject);
      }
    );
  });
}

module.exports = {
  createTakeover,
  findById,
  findActiveBySession,
  findLatestBySession,
  findLatestBySessionIds,
  findActiveBySessionIds,
  releaseTakeover
};
