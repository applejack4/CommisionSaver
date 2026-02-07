const { getDatabase } = require('../database');

const BOOKING_STATUSES = Object.freeze({
  HOLD: 'hold',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
});

const LEGACY_STATUS_MAP = Object.freeze({
  pending: BOOKING_STATUSES.HOLD,
  payment_pending: BOOKING_STATUSES.HOLD,
  rejected: BOOKING_STATUSES.CANCELLED
});

function normalizeStatus(status) {
  if (!status) return null;
  const normalized = String(status).trim().toLowerCase();
  if (LEGACY_STATUS_MAP[normalized]) {
    return LEGACY_STATUS_MAP[normalized];
  }
  if (Object.values(BOOKING_STATUSES).includes(normalized)) {
    return normalized;
  }
  return null;
}

function isAllowedTransition(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true;
  if (fromStatus === BOOKING_STATUSES.HOLD) {
    return [
      BOOKING_STATUSES.CONFIRMED,
      BOOKING_STATUSES.CANCELLED,
      BOOKING_STATUSES.EXPIRED
    ].includes(toStatus);
  }
  if (fromStatus === BOOKING_STATUSES.CONFIRMED) {
    return toStatus === BOOKING_STATUSES.CANCELLED;
  }
  return false;
}

/**
 * Create a new booking with HOLD status
 * @param {Object} bookingData - Booking data
 * @param {string} bookingData.customer_name - Customer name (optional)
 * @param {string} bookingData.customer_phone - Customer phone number
 * @param {number} bookingData.trip_id - Trip ID
 * @param {number} bookingData.seat_count - Number of seats (default: 1)
 * @param {number} bookingData.hold_duration_minutes - Hold duration in minutes (default: 10)
 * @param {string} bookingData.lock_key - Redis lock key for this booking (optional)
 * @returns {Promise<Object>} Created booking object with id
 */
async function create(bookingData) {
  const db = await getDatabase();
  
  const {
    customer_name = null,
    customer_phone,
    trip_id,
    seat_count = 1,
    hold_duration_minutes = 10,
    lock_key = null
  } = bookingData;

  // Calculate hold expiration time
  const holdExpiresAt = new Date();
  holdExpiresAt.setMinutes(holdExpiresAt.getMinutes() + hold_duration_minutes);

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO bookings (customer_name, customer_phone, trip_id, seat_count, status, hold_expires_at, lock_key)
       VALUES (?, ?, ?, ?, 'hold', ?, ?)`,
      [customer_name, customer_phone, trip_id, seat_count, holdExpiresAt.toISOString(), lock_key],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        
        findById(this.lastID)
          .then(booking => resolve(booking))
          .catch(reject);
      }
    );
  });
}

/**
 * Find booking by ID with trip details
 * @param {number} id - Booking ID
 * @returns {Promise<Object|null>} Booking object with trip details or null
 */
async function findById(id) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.price
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.id = ?`,
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
 * Find bookings by customer phone number
 * @param {string} phoneNumber - Customer phone number
 * @returns {Promise<Array>} Array of booking objects with trip details
 */
async function findByPhone(phoneNumber) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.price
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.customer_phone = ?
       ORDER BY b.created_at DESC`,
      [phoneNumber],
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
 * Find active holds for a trip
 * @param {number} tripId - Trip ID
 * @returns {Promise<Array>} Array of active hold bookings
 */
async function findActiveHoldsByTrip(tripId) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.trip_id = ? AND b.status = 'hold' AND b.hold_expires_at > datetime('now')
       ORDER BY b.created_at ASC`,
      [tripId],
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
 * Find expired holds
 * @returns {Promise<Array>} Array of expired hold bookings
 */
async function findExpiredHolds() {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.status = 'hold' AND b.hold_expires_at <= datetime('now')`,
      [],
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
 * Find active holds (status = 'hold')
 * @returns {Promise<Array>} Array of active hold bookings
 */
async function findActiveHolds() {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.status = 'hold'
       ORDER BY b.created_at DESC`,
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
 * Update booking status
 * @param {number} id - Booking ID
 * @param {string} status - New status ('hold', 'confirmed', 'expired')
 * @returns {Promise<Object|null>} Updated booking object or null if not found
 */
async function transitionStatus(id, status, options = {}) {
  const db = await getDatabase();
  const booking = await findById(id);
  if (!booking) {
    return null;
  }

  const currentStatus = normalizeStatus(booking.status);
  const nextStatus = normalizeStatus(status);
  if (!currentStatus || !nextStatus) {
    throw new Error(`Invalid booking status transition: ${booking.status} -> ${status}`);
  }
  if (!isAllowedTransition(currentStatus, nextStatus)) {
    throw new Error(`Disallowed booking status transition: ${currentStatus} -> ${nextStatus}`);
  }

  const setParts = ['status = ?'];
  const values = [nextStatus];

  if (nextStatus !== BOOKING_STATUSES.HOLD) {
    setParts.push('hold_expires_at = NULL');
  }

  if (nextStatus === BOOKING_STATUSES.CONFIRMED) {
    if (options.ticketAttachmentId) {
      setParts.push('ticket_attachment_id = ?');
      values.push(options.ticketAttachmentId);
      setParts.push('ticket_received_at = datetime(\'now\')');
    }
  }

  values.push(id);

  const shouldReleaseLock =
    currentStatus === BOOKING_STATUSES.HOLD && nextStatus !== BOOKING_STATUSES.HOLD;

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE bookings SET ${setParts.join(', ')} WHERE id = ?`,
      values,
      async function (err) {
        if (err) {
          reject(err);
          return;
        }

        try {
          if (shouldReleaseLock && typeof options.releaseInventoryLock === 'function') {
            await options.releaseInventoryLock();
          }
          const updated = await findById(id);
          resolve(updated);
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

async function updateStatus(id, status, options = {}) {
  return transitionStatus(id, status, options);
}

/**
 * Confirm booking when ticket is received
 * @param {number} id - Booking ID
 * @param {string} ticketAttachmentId - WhatsApp media ID of ticket
 * @returns {Promise<Object|null>} Updated booking object
 */
async function confirmWithTicket(id, ticketAttachmentId, options = {}) {
  return transitionStatus(id, BOOKING_STATUSES.CONFIRMED, {
    ...options,
    ticketAttachmentId
  });
}

/**
 * Expire a hold (release seats back to available pool)
 * @param {number} id - Booking ID
 * @returns {Promise<Object|null>} Updated booking object
 */
async function expireHold(id, options = {}) {
  return transitionStatus(id, BOOKING_STATUSES.EXPIRED, options);
}

/**
 * Find bookings by trip ID
 * @param {number} tripId - Trip ID
 * @returns {Promise<Array>} Array of booking objects
 */
async function findByTripId(tripId) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.price
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.trip_id = ?
       ORDER BY b.created_at DESC`,
      [tripId],
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
 * Find confirmed bookings that need reminders (6 hours before journey)
 * @param {Date} currentTime - Current time
 * @returns {Promise<Array>} Array of booking objects that need reminders
 */
async function findBookingsNeedingReminders(currentTime = new Date()) {
  const db = await getDatabase();
  
  // Calculate 6 hours from now
  const sixHoursLater = new Date(currentTime.getTime() + 6 * 60 * 60 * 1000);
  const currentTimeStr = currentTime.toISOString().split('T')[0] + ' ' + 
                        currentTime.toTimeString().split(' ')[0];
  const sixHoursLaterStr = sixHoursLater.toISOString().split('T')[0] + ' ' + 
                          sixHoursLater.toTimeString().split(' ')[0];
  
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       LEFT JOIN message_logs ml ON b.id = ml.booking_id AND ml.type = 'reminder'
       WHERE b.status = 'confirmed'
         AND ml.id IS NULL
         AND datetime(t.journey_date || ' ' || t.departure_time) BETWEEN datetime(?) AND datetime(?)
       ORDER BY t.journey_date ASC, t.departure_time ASC`,
      [currentTimeStr, sixHoursLaterStr],
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
 * Check if booking has a reminder sent
 * @param {number} bookingId - Booking ID
 * @param {string} type - Message type (default: 'reminder')
 * @returns {Promise<boolean>} True if reminder exists, false otherwise
 */
async function hasReminder(bookingId, type = 'reminder') {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM message_logs WHERE booking_id = ? AND type = ?',
      [bookingId, type],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(!!row);
      }
    );
  });
}

module.exports = {
  create,
  findById,
  findByPhone,
  findActiveHoldsByTrip,
  findActiveHolds,
  findExpiredHolds,
  updateStatus,
  transitionStatus,
  normalizeStatus,
  confirmWithTicket,
  expireHold,
  findByTripId,
  findBookingsNeedingReminders,
  hasReminder
};
