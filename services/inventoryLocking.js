function buildSeatLockKey(tripId, seatNumber) {
  return `lock:trip:${tripId}:seat:${seatNumber}`;
}

function parseJsonArray(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function getLockKeysForBooking(booking) {
  if (!booking) return [];
  const storedKeys = parseJsonArray(booking.lock_keys);
  if (storedKeys && storedKeys.length > 0) {
    return storedKeys.map((key) => String(key));
  }
  if (booking.lock_key) {
    return [String(booking.lock_key)];
  }
  const seatNumbers = parseJsonArray(booking.seat_numbers);
  if (seatNumbers && seatNumbers.length > 0 && booking.trip_id) {
    return seatNumbers.map((seatNumber) =>
      buildSeatLockKey(booking.trip_id, seatNumber)
    );
  }
  return [];
}

async function releaseLockKeys(lockService, lockKeys, options = {}) {
  const { bookingId = null, reason = 'release' } = options;
  if (!Array.isArray(lockKeys) || lockKeys.length === 0) {
    console.warn('[inventory-locks] No lock keys to release', {
      bookingId,
      reason
    });
    return { released: 0, errors: [] };
  }

  const errors = [];
  let released = 0;
  for (const lockKey of lockKeys) {
    try {
      await lockService.expire(lockKey);
      released += 1;
    } catch (error) {
      errors.push({ lockKey, error });
      console.error('[inventory-locks] Failed to release lock', {
        bookingId,
        reason,
        lockKey,
        error: error?.message
      });
    }
  }

  if (errors.length > 0) {
    const firstError = errors[0].error;
    throw firstError;
  }

  console.log('[inventory-locks] Released locks', {
    bookingId,
    reason,
    released
  });
  return { released, errors };
}

module.exports = {
  buildSeatLockKey,
  getLockKeysForBooking,
  parseJsonArray,
  releaseLockKeys
};
