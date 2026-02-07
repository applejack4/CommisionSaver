const bookingModel = require('../models/booking');
const auditEventModel = require('../models/auditEvent');
const { buildSeatLockKey, getLockKeysForBooking } = require('./inventoryLocking');

function defaultLockKeyForBooking(booking) {
  const keys = getLockKeysForBooking(booking);
  if (keys.length > 0) {
    return keys[0];
  }

  const { trip_id: tripId, journey_date: journeyDate, departure_time: departureTime } = booking || {};
  if (!tripId || !journeyDate || !departureTime) {
    throw new Error('Missing booking fields required to derive lock key');
  }

  return buildSeatLockKey(tripId, 1);
}

/**
 * Reconcile DB holds that lost their Redis lock (e.g., after Redis restart).
 * - Expires the booking
 * - Emits INVENTORY_RELEASED in audit_events
 */
async function reconcileOrphanedInventoryLocks(redisClient, options = {}) {
  if (!redisClient || typeof redisClient.exists !== 'function') {
    throw new Error('Redis client does not support exists');
  }

  const {
    lockKeyForBooking = defaultLockKeyForBooking,
    bookings = null
  } = options;

  const holds = bookings || (await bookingModel.findActiveHolds());
  let released = 0;

  for (const hold of holds) {
    const lockKeys = getLockKeysForBooking(hold);
    if (lockKeys.length === 0) {
      console.warn('[inventory-locks] HELD booking missing lock keys', {
        bookingId: hold.id,
        tripId: hold.trip_id
      });
    }

    let hasAnyLock = false;
    for (const lockKey of lockKeys) {
      const exists = await redisClient.exists(lockKey);
      if (exists) {
        hasAnyLock = true;
        break;
      }
    }

    if (hasAnyLock) {
      continue;
    }

    const expired = await bookingModel.expireHold(hold.id);
    if (!expired) {
      continue;
    }

    await auditEventModel.create({
      event_type: 'INVENTORY_RELEASED',
      session_id: `sess_${hold.id}`,
      payload: {
        booking_id: hold.id,
        lockKeys
      }
    });

    released++;
  }

  return { released };
}

module.exports = {
  reconcileOrphanedInventoryLocks,
  defaultLockKeyForBooking
};
