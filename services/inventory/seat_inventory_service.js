const { createClient } = require('redis');
const bookingModel = require('../../models/booking');
const tripModel = require('../../models/trip');
const inventoryOverrideModel = require('../../models/inventoryOverride');
const auditEventModel = require('../../models/auditEvent');
const { InventoryOverrideCache } = require('../redis/InventoryOverrideCache');
const { InventoryLockService } = require('../redis/InventoryLockService');
const { getLockKeysForBooking, releaseLockKeys } = require('../inventoryLocking');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

function buildOverrideCacheKey(routeId, tripDate) {
  return `inventory:blocked:route:${routeId}:date:${tripDate}`;
}

function normalizeSeatNumbers(seatNumbers) {
  return inventoryOverrideModel.normalizeSeatNumbers(seatNumbers);
}

async function validateSeatsExist(trips, seatNumbers) {
  for (const trip of trips) {
    const maxSeat = trip.whatsapp_seat_quota || 0;
    const invalid = seatNumbers.filter((seat) => seat < 1 || seat > maxSeat);
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `Invalid seat numbers for trip ${trip.id}: ${invalid.join(', ')}`
      };
    }
  }
  return { ok: true };
}

async function findConfirmedSeatConflicts(trips, seatNumbers) {
  const conflicts = [];

  for (const trip of trips) {
    const bookings = await bookingModel.findByTripId(trip.id);
    const confirmed = bookings.filter(
      (booking) => bookingModel.normalizeStatus(booking.status) === 'confirmed'
    );
    const blockedSet = new Set(seatNumbers);

    for (const booking of confirmed) {
      const bookingSeats = bookingModel.getSeatNumbers(booking);
      if (!bookingSeats || bookingSeats.length === 0) {
        return {
          conflict: true,
          reason: `Confirmed booking ${booking.id} has no seat numbers`
        };
      }
      for (const seat of bookingSeats) {
        if (blockedSet.has(Number(seat))) {
          conflicts.push({ bookingId: booking.id, seatNumber: seat });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return { conflict: true, conflicts };
  }
  return { conflict: false };
}

async function withRedisClient(handler) {
  let parsed = null;
  try {
    parsed = new URL(REDIS_URL);
  } catch (error) {}
  const redisClient = createClient({ url: REDIS_URL });
  try {
    await redisClient.connect();
  } catch (error) {
    throw error;
  }
  try {
    return await handler(redisClient);
  } finally {
    try {
      await redisClient.quit();
    } catch (error) {
      redisClient.disconnect();
    }
  }
}

async function blockSeats({ routeId, tripDate, seatNumbers, reason, actorType, actorId, idempotencyKey }) {
  const normalizedSeats = normalizeSeatNumbers(seatNumbers);
  if (normalizedSeats.length === 0) {
    throw new Error('seat_numbers must be a non-empty array of positive integers');
  }

  const trips = await tripModel.findByRouteDate(routeId, tripDate);
  if (!trips || trips.length === 0) {
    throw new Error('Trip not found for provided route/date');
  }

  const seatValidation = await validateSeatsExist(trips, normalizedSeats);
  if (!seatValidation.ok) {
    throw new Error(seatValidation.message);
  }

  const conflicts = await findConfirmedSeatConflicts(trips, normalizedSeats);
  if (conflicts.conflict) {
    const detail = conflicts.conflicts?.length
      ? `Seats already confirmed: ${conflicts.conflicts
          .map((item) => `${item.seatNumber} (booking ${item.bookingId})`)
          .join(', ')}`
      : conflicts.reason;
    const error = new Error(detail || 'Seat(s) already confirmed');
    error.code = 'SEAT_ALREADY_CONFIRMED';
    throw error;
  }

  const updated = await inventoryOverrideModel.upsertBlockedSeats({
    routeId,
    tripDate,
    seatNumbers: normalizedSeats,
    reason,
    actorType,
    actorId
  });

  await withRedisClient(async (redisClient) => {
    const cache = new InventoryOverrideCache(redisClient);
    const cacheKey = buildOverrideCacheKey(routeId, tripDate);
    await cache.block(cacheKey, normalizedSeats);
  });

  await auditEventModel.create({
    event_type: 'INVENTORY_SEATS_BLOCKED',
    session_id: null,
    operator_id: actorType === 'operator' ? actorId : null,
    idempotency_key: idempotencyKey || null,
    payload: {
      route_id: routeId,
      trip_date: tripDate,
      seat_numbers: normalizedSeats,
      reason: reason || null,
      actor: actorType
    }
  });

  return {
    route_id: routeId,
    trip_date: tripDate,
    seat_numbers: normalizedSeats,
    status: 'blocked',
    updated: updated.updated
  };
}

async function unblockSeats({ routeId, tripDate, seatNumbers, reason, actorType, actorId, idempotencyKey }) {
  const normalizedSeats = normalizeSeatNumbers(seatNumbers);
  if (normalizedSeats.length === 0) {
    throw new Error('seat_numbers must be a non-empty array of positive integers');
  }

  const trips = await tripModel.findByRouteDate(routeId, tripDate);
  if (!trips || trips.length === 0) {
    throw new Error('Trip not found for provided route/date');
  }

  const seatValidation = await validateSeatsExist(trips, normalizedSeats);
  if (!seatValidation.ok) {
    throw new Error(seatValidation.message);
  }

  const updated = await inventoryOverrideModel.markSeatsUnblocked({
    routeId,
    tripDate,
    seatNumbers: normalizedSeats,
    reason,
    actorType,
    actorId
  });

  await withRedisClient(async (redisClient) => {
    const cache = new InventoryOverrideCache(redisClient);
    const cacheKey = buildOverrideCacheKey(routeId, tripDate);
    await cache.unblock(cacheKey, normalizedSeats);
  });

  await auditEventModel.create({
    event_type: 'INVENTORY_SEATS_UNBLOCKED',
    session_id: null,
    operator_id: actorType === 'operator' ? actorId : null,
    idempotency_key: idempotencyKey || null,
    payload: {
      route_id: routeId,
      trip_date: tripDate,
      seat_numbers: normalizedSeats,
      reason: reason || null,
      actor: actorType
    }
  });

  return {
    route_id: routeId,
    trip_date: tripDate,
    seat_numbers: normalizedSeats,
    status: 'unblocked',
    updated: updated.updated
  };
}

async function releaseSeatsFromBooking({ booking, reason = 'cancel', redisClient = null }) {
  if (!booking) {
    throw new Error('booking is required');
  }
  const lockKeys = getLockKeysForBooking(booking);
  if (lockKeys.length === 0) {
    return { released: 0, lockKeys: [] };
  }

  if (redisClient) {
    const lockService = new InventoryLockService(redisClient);
    await releaseLockKeys(lockService, lockKeys, {
      bookingId: booking.id,
      reason
    });
    return { released: lockKeys.length, lockKeys };
  }

  return await withRedisClient(async (client) => {
    const lockService = new InventoryLockService(client);
    await releaseLockKeys(lockService, lockKeys, {
      bookingId: booking.id,
      reason
    });
    return { released: lockKeys.length, lockKeys };
  });
}

module.exports = {
  blockSeats,
  unblockSeats,
  releaseSeatsFromBooking,
  buildOverrideCacheKey
};
