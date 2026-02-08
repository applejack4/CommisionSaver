const inventoryOverrideModel = require('../../models/inventoryOverride');
const { buildSeatLockKey, releaseLockKeys } = require('../inventoryLocking');

async function acquireSeatLocks({
  lockService,
  trip,
  seatCount,
  sessionId,
  ttlSeconds
}) {
  const seatNumbers = [];
  const lockKeys = [];

  const blockedSeats = await inventoryOverrideModel.findBlockedSeats(
    trip.route_id,
    trip.journey_date
  );
  const blockedSet = new Set(blockedSeats.map((seat) => Number(seat)));

  for (let seatNumber = 1; seatNumber <= trip.whatsapp_seat_quota && seatNumbers.length < seatCount; seatNumber += 1) {
    if (blockedSet.has(seatNumber)) {
      continue;
    }
    const lockKey = buildSeatLockKey(trip.id, seatNumber);
    try {
      const acquired = await lockService.acquire(lockKey, sessionId, ttlSeconds);
      if (acquired) {
        seatNumbers.push(seatNumber);
        lockKeys.push(lockKey);
      }
    } catch (error) {
      await releaseLockKeys(lockService, lockKeys, {
        bookingId: null,
        reason: 'acquire-failed'
      });
      throw error;
    }
  }

  if (seatNumbers.length < seatCount) {
    await releaseLockKeys(lockService, lockKeys, {
      bookingId: null,
      reason: 'acquire-insufficient'
    });
    return { acquired: false, seatNumbers: [], lockKeys: [] };
  }

  console.log('[inventory-locks] Acquired locks', {
    tripId: trip.id,
    seatCount,
    lockKeys
  });
  return { acquired: true, seatNumbers, lockKeys };
}

module.exports = {
  acquireSeatLocks
};
