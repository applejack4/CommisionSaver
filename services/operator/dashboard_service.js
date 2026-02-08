const { createClient } = require('redis');
const { getDatabase } = require('../../database');
const bookingModel = require('../../models/booking');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const DEFAULT_LIMIT = Number.parseInt(
  process.env.OPERATOR_DASHBOARD_LIMIT || '50',
  10
);

async function queryBookings({ operatorId, limit }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.operator_id
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE r.operator_id = ?
       ORDER BY b.created_at DESC
       LIMIT ?`,
      [operatorId, limit],
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

async function queryTrips({ operatorId, startDate, endDate }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT t.*, r.source, r.destination, r.price, r.operator_id
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       WHERE r.operator_id = ? AND t.journey_date BETWEEN ? AND ?
       ORDER BY t.journey_date ASC, t.departure_time ASC`,
      [operatorId, startDate, endDate],
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

async function collectLockKeysForTrip(tripId) {
  const holds = await bookingModel.findActiveHoldsByTrip(tripId);
  const keys = new Set();
  for (const hold of holds) {
    for (const key of bookingModel.getLockKeys(hold)) {
      keys.add(String(key));
    }
  }
  return keys;
}

async function getRedisLocks(redisClient, tripId, activeLockKeys) {
  const locks = [];
  const pattern = `lock:trip:${tripId}:seat:*`;
  let scanned = 0;
  try {
    for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const keysBatch = Array.isArray(key) ? key : [key];
      for (const lockKey of keysBatch) {
        scanned += 1;
        const [owner, ttl] = await Promise.all([
          redisClient.get(lockKey),
          redisClient.ttl(lockKey)
        ]);
        const ttlSeconds = Number.isFinite(ttl) ? ttl : null;
        const stale = !activeLockKeys.has(lockKey) || ttlSeconds <= 0;
        locks.push({
          key: lockKey,
          owner,
          ttl_seconds: ttlSeconds,
          stale
        });
      }
    }
  } catch (error) {
    throw error;
  }
  return locks;
}

async function getDashboardBookings({ operatorId, limit = DEFAULT_LIMIT }) {
  if (!operatorId) {
    throw new Error('operatorId is required');
  }
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : DEFAULT_LIMIT;
  return queryBookings({ operatorId, limit: safeLimit });
}

async function getDashboardTrips({ operatorId, startDate, endDate, redisClient }) {
  if (!operatorId) {
    throw new Error('operatorId is required');
  }
  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const trips = await queryTrips({ operatorId, startDate, endDate });
  const client = redisClient || createClient({ url: REDIS_URL });
  const shouldCloseClient = !redisClient;

  try {
    if (!client.isOpen) {
      await client.connect();
    }

    const enriched = [];
    for (const trip of trips) {
      const activeLockKeys = await collectLockKeysForTrip(trip.id);
      const locks = await getRedisLocks(client, trip.id, activeLockKeys);
      enriched.push({
        ...trip,
        locks,
        lock_count: locks.length
      });
    }

    return enriched;
  } finally {
    if (shouldCloseClient) {
      try {
        await client.quit();
      } catch (error) {
        client.disconnect();
      }
    }
  }
}

module.exports = {
  getDashboardBookings,
  getDashboardTrips
};
