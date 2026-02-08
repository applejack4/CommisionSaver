const { getDatabase } = require('../database');

async function findByBookingId(bookingId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM cancellations WHERE booking_id = ?`,
      [bookingId],
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

async function createIfMissing({
  bookingId,
  cancelledBy,
  cancellationReason,
  actorId,
  cancelledAt
}) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO cancellations
       (booking_id, cancelled_at, cancelled_by, cancellation_reason, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        bookingId,
        cancelledAt || new Date().toISOString(),
        cancelledBy,
        cancellationReason || null,
        actorId || null
      ],
      async function (err) {
        if (err) {
          reject(err);
          return;
        }
        try {
          const record = await findByBookingId(bookingId);
          resolve(record);
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

module.exports = {
  findByBookingId,
  createIfMissing
};
