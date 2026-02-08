const { getDatabase } = require('../database');
const inventoryOverrideModel = require('./inventoryOverride');

/**
 * Create a new trip
 * @param {Object} tripData - Trip data
 * @param {number} tripData.route_id - Route ID
 * @param {string} tripData.journey_date - Journey date (YYYY-MM-DD)
 * @param {string} tripData.departure_time - Departure time (HH:MM)
 * @param {number} tripData.whatsapp_seat_quota - WhatsApp seat quota
 * @returns {Promise<Object>} Created trip object
 */
async function create(tripData) {
  const db = await getDatabase();
  
  const {
    route_id,
    journey_date,
    departure_time,
    whatsapp_seat_quota = 0
  } = tripData;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO trips (route_id, journey_date, departure_time, whatsapp_seat_quota)
       VALUES (?, ?, ?, ?)`,
      [route_id, journey_date, departure_time, whatsapp_seat_quota],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        
        findById(this.lastID)
          .then(trip => resolve(trip))
          .catch(reject);
      }
    );
  });
}

/**
 * Find trip by ID
 * @param {number} id - Trip ID
 * @returns {Promise<Object|null>} Trip object with route details or null
 */
async function findById(id) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT t.*, r.source, r.destination, r.price, r.operator_id
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       WHERE t.id = ?`,
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

/**
 * Find trip by route, date, and time
 * @param {number} route_id - Route ID
 * @param {string} journey_date - Journey date (YYYY-MM-DD)
 * @param {string} departure_time - Departure time (HH:MM)
 * @returns {Promise<Object|null>} Trip object or null
 */
async function findByRouteDateTime(route_id, journey_date, departure_time) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT t.*, r.source, r.destination, r.price, r.operator_id
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       WHERE t.route_id = ? AND t.journey_date = ? AND t.departure_time = ?`,
      [route_id, journey_date, departure_time],
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

/**
 * Find trips by route and date
 * @param {number} route_id - Route ID
 * @param {string} journey_date - Journey date (YYYY-MM-DD)
 * @returns {Promise<Array>} Array of trip objects
 */
async function findByRouteDate(route_id, journey_date) {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT t.*, r.source, r.destination, r.price, r.operator_id
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       WHERE t.route_id = ? AND t.journey_date = ?
       ORDER BY t.departure_time ASC`,
      [route_id, journey_date],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      }
    );
  });
}

/**
 * Find all trips for a date range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<Array>} Array of trip objects
 */
async function findByDateRange(startDate, endDate) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT t.*, r.source, r.destination, r.price, r.operator_id
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       WHERE t.journey_date BETWEEN ? AND ?
       ORDER BY t.journey_date ASC, t.departure_time ASC`,
      [startDate, endDate],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      }
    );
  });
}

/**
 * Update trip seat quota
 * @param {number} id - Trip ID
 * @param {number} whatsapp_seat_quota - New seat quota
 * @returns {Promise<Object|null>} Updated trip object
 */
async function updateSeatQuota(id, whatsapp_seat_quota) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE trips SET whatsapp_seat_quota = ? WHERE id = ?',
      [whatsapp_seat_quota, id],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        
        if (this.changes === 0) {
          resolve(null);
          return;
        }
        
        findById(id)
          .then(trip => resolve(trip))
          .catch(reject);
      }
    );
  });
}

/**
 * Get available seats for a trip (quota - confirmed - held)
 * @param {number} tripId - Trip ID
 * @returns {Promise<number>} Available seat count
 */
async function getAvailableSeats(tripId) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    // Get trip quota
    db.get(
      'SELECT whatsapp_seat_quota FROM trips WHERE id = ?',
      [tripId],
      (err, trip) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!trip) {
          resolve(0);
          return;
        }
        
        // Count confirmed seats
        db.get(
          `SELECT COALESCE(SUM(seat_count), 0) as confirmed_seats
           FROM bookings
           WHERE trip_id = ? AND status = 'confirmed'`,
          [tripId],
          (err, confirmed) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Count active holds (not expired)
            db.get(
              `SELECT COALESCE(SUM(seat_count), 0) as held_seats
               FROM bookings
               WHERE trip_id = ? AND status = 'hold' AND hold_expires_at > datetime('now')`,
              [tripId],
              async (err, held) => {
                if (err) {
                  reject(err);
                  return;
                }
                try {
                  const blockedCount = await inventoryOverrideModel.countBlockedSeats(
                    trip.route_id,
                    trip.journey_date
                  );
                  const available = trip.whatsapp_seat_quota -
                                   (confirmed.confirmed_seats || 0) -
                                   (held.held_seats || 0) -
                                   blockedCount;
                  resolve(Math.max(0, available));
                } catch (error) {
                  reject(error);
                }
              }
            );
          }
        );
      }
    );
  });
}

/**
 * Get trip statistics (available, held, confirmed seats)
 * @param {number} tripId - Trip ID
 * @returns {Promise<Object>} Statistics object
 */
async function getTripStats(tripId) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 
        t.whatsapp_seat_quota,
        t.route_id,
        t.journey_date,
        COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN b.seat_count ELSE 0 END), 0) as confirmed_seats,
        COALESCE(SUM(CASE WHEN b.status = 'hold' AND b.hold_expires_at > datetime('now') THEN b.seat_count ELSE 0 END), 0) as held_seats
       FROM trips t
       LEFT JOIN bookings b ON t.id = b.trip_id
       WHERE t.id = ?
       GROUP BY t.id, t.whatsapp_seat_quota`,
      [tripId],
      async (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!row) {
          resolve(null);
          return;
        }

        try {
          const blockedCount = await inventoryOverrideModel.countBlockedSeats(
            row.route_id,
            row.journey_date
          );
          const available =
            row.whatsapp_seat_quota - row.confirmed_seats - row.held_seats - blockedCount;
          
          resolve({
            quota: row.whatsapp_seat_quota,
            available: Math.max(0, available),
            held: row.held_seats,
            confirmed: row.confirmed_seats
          });
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

module.exports = {
  create,
  findById,
  findByRouteDateTime,
  findByRouteDate,
  findByDateRange,
  updateSeatQuota,
  getAvailableSeats,
  getTripStats
};
