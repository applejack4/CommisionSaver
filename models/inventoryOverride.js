const { getDatabase } = require('../database');

function normalizeSeatNumbers(seatNumbers) {
  if (!Array.isArray(seatNumbers)) {
    return [];
  }
  const normalized = seatNumbers
    .map((seat) => Number(seat))
    .filter((seat) => Number.isInteger(seat) && seat > 0);
  return Array.from(new Set(normalized)).sort((a, b) => a - b);
}

async function findBlockedSeats(routeId, tripDate, seatNumbers = null) {
  const db = await getDatabase();
  const normalized = normalizeSeatNumbers(seatNumbers);

  return new Promise((resolve, reject) => {
    const filters = ['route_id = ?', 'trip_date = ?', "status = 'blocked'"];
    const values = [routeId, tripDate];

    if (normalized && normalized.length > 0) {
      const placeholders = normalized.map(() => '?').join(',');
      filters.push(`seat_number IN (${placeholders})`);
      values.push(...normalized);
    }

    db.all(
      `SELECT seat_number FROM inventory_overrides WHERE ${filters.join(' AND ')}`,
      values,
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((rows || []).map((row) => Number(row.seat_number)));
      }
    );
  });
}

async function countBlockedSeats(routeId, tripDate) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as blocked_count
       FROM inventory_overrides
       WHERE route_id = ? AND trip_date = ? AND status = 'blocked'`,
      [routeId, tripDate],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(Number(row?.blocked_count || 0));
      }
    );
  });
}

async function upsertBlockedSeats({ routeId, tripDate, seatNumbers, reason, actorType, actorId }) {
  const db = await getDatabase();
  const normalized = normalizeSeatNumbers(seatNumbers);
  if (normalized.length === 0) {
    return { updated: 0, seatNumbers: [] };
  }

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const statement = db.prepare(
        `INSERT INTO inventory_overrides (
           route_id,
           trip_date,
           seat_number,
           status,
           reason,
           actor_type,
           actor_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'blocked', ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(route_id, trip_date, seat_number) DO UPDATE SET
           status = 'blocked',
           reason = excluded.reason,
           actor_type = excluded.actor_type,
           actor_id = excluded.actor_id,
           updated_at = datetime('now'),
           unblocked_at = NULL,
           unblocked_by = NULL`
      );

      let updated = 0;
      for (const seatNumber of normalized) {
        statement.run(
          [routeId, tripDate, seatNumber, reason || null, actorType, actorId || null],
          function (err) {
            if (err) {
              statement.finalize();
              db.run('ROLLBACK');
              reject(err);
              return;
            }
            updated += 1;
          }
        );
      }

      statement.finalize((finalizeErr) => {
        if (finalizeErr) {
          db.run('ROLLBACK');
          reject(finalizeErr);
          return;
        }
        db.run('COMMIT', (commitErr) => {
          if (commitErr) {
            db.run('ROLLBACK');
            reject(commitErr);
            return;
          }
          resolve({ updated, seatNumbers: normalized });
        });
      });
    });
  });
}

async function markSeatsUnblocked({ routeId, tripDate, seatNumbers, reason, actorType, actorId }) {
  const db = await getDatabase();
  const normalized = normalizeSeatNumbers(seatNumbers);
  if (normalized.length === 0) {
    return { updated: 0, seatNumbers: [] };
  }

  return new Promise((resolve, reject) => {
    const placeholders = normalized.map(() => '?').join(',');
    const values = [
      reason || null,
      actorType,
      actorId || null,
      actorId || actorType,
      routeId,
      tripDate,
      ...normalized
    ];

    db.run(
      `UPDATE inventory_overrides
       SET status = 'unblocked',
           reason = COALESCE(?, reason),
           actor_type = ?,
           actor_id = ?,
           unblocked_at = datetime('now'),
           unblocked_by = ?,
           updated_at = datetime('now')
       WHERE route_id = ?
         AND trip_date = ?
         AND seat_number IN (${placeholders})
         AND status = 'blocked'`,
      values,
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ updated: this.changes || 0, seatNumbers: normalized });
      }
    );
  });
}

module.exports = {
  normalizeSeatNumbers,
  findBlockedSeats,
  countBlockedSeats,
  upsertBlockedSeats,
  markSeatsUnblocked
};
