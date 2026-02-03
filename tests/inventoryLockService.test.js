const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { createClient } = require('redis');
const { InventoryLockService, STATUS } = require('../services/redis/InventoryLockService');
const bookingModel = require('../models/booking');
const tripModel = require('../models/trip');
const { getDatabase } = require('../database');
const {
  reconcileOrphanedInventoryLocks,
  defaultLockKeyForBooking
} = require('../services/inventoryLockReconciliation');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_RESTART_COMMAND = process.env.REDIS_RESTART_COMMAND;

let client;
let service;

function buildLockKey(suffix) {
  const now = Date.now();
  return `lock:seat:test:${now}:${suffix}`;
}

async function connectRedis() {
  client = createClient({ url: REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  service = new InventoryLockService(client);
}

async function disconnectRedis() {
  if (!client) return;
  try {
    await client.quit();
  } catch (error) {
    try {
      client.disconnect();
    } catch (disconnectError) {}
  }
}

async function restartRedis() {
  await disconnectRedis();

  if (REDIS_RESTART_COMMAND) {
    execSync(REDIS_RESTART_COMMAND, { stdio: 'inherit' });
  } else {
    const admin = createClient({ url: REDIS_URL });
    await admin.connect();
    try {
      await admin.sendCommand(['SHUTDOWN', 'NOSAVE']);
    } catch (error) {
      throw new Error(
        'Redis restart failed. Provide REDIS_RESTART_COMMAND or run Redis with auto-restart.'
      );
    } finally {
      try {
        await admin.quit();
      } catch (quitError) {}
    }
  }

  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      await connectRedis();
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error('Redis did not restart within 10s');
}

async function getAnyTripId() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM trips LIMIT 1', (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        reject(new Error('No trips available for booking test data'));
        return;
      }
      resolve(row.id);
    });
  });
}

async function findAuditEventByTypeAndSession(eventType, sessionId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM audit_events
       WHERE event_type = ? AND session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [eventType, sessionId],
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

before(async () => {
  await connectRedis();
});

after(async () => {
  await disconnectRedis();
});

beforeEach(async () => {
  await client.flushDb();
});

test('Test A - parallel acquire with different sessions', async () => {
  const lockKey = buildLockKey('parallel');
  const results = await Promise.all([
    service.execute('ACQUIRE', lockKey, 'session-a', 10),
    service.execute('ACQUIRE', lockKey, 'session-b', 10)
  ]);

  const acquiredCount = results.filter((status) => status === STATUS.ACQUIRED).length;
  const lockedCount = results.filter((status) => status === STATUS.LOCKED_BY_OTHER).length;

  assert.strictEqual(acquiredCount, 1);
  assert.strictEqual(lockedCount, 1);
});

test('Test B - idempotent retry with same session', async () => {
  const lockKey = buildLockKey('idempotent');
  const first = await service.execute('ACQUIRE', lockKey, 'session-a', 10);
  const ttlAfterFirst = await client.ttl(lockKey);
  const retry = await service.execute('ACQUIRE', lockKey, 'session-a', 10);
  const ttlAfterRetry = await client.ttl(lockKey);

  assert.strictEqual(first, STATUS.ACQUIRED);
  assert.strictEqual(retry, STATUS.ALREADY_OWNED);
  assert.ok(ttlAfterRetry <= ttlAfterFirst);
});

test('Test C - TTL expiry allows reacquire', async () => {
  const lockKey = buildLockKey('ttl');
  const acquired = await service.acquire(lockKey, 'session-a', 3);
  assert.strictEqual(acquired, true);

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const reacquired = await service.acquire(lockKey, 'session-b', 3);
  assert.strictEqual(reacquired, true);

  const extendStatus = await service.execute('EXTEND', lockKey, 'session-a', 3);
  assert.strictEqual(extendStatus, STATUS.NOT_FOUND);

  const releaseStatus = await service.execute('RELEASE', lockKey, 'session-a');
  assert.strictEqual(releaseStatus, STATUS.NOT_FOUND);
});

test('Test D - Redis restart reconciliation', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const lockKey = `lock:seat:${trip.id}:${trip.journey_date}:${trip.departure_time}`;
  const booking = await bookingModel.create({
    customer_name: 'Reconcile Test',
    customer_phone: `999${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    hold_duration_minutes: 10,
    lock_key: lockKey
  });

  const sessionId = `sess_${booking.id}`;

  const acquired = await service.acquire(lockKey, sessionId, 10);
  assert.strictEqual(acquired, true);

  await restartRedis();

  const existsAfterRestart = await client.exists(lockKey);
  assert.strictEqual(existsAfterRestart, 0);

  const reconciled = await reconcileOrphanedInventoryLocks(client, {
    lockKeyForBooking: defaultLockKeyForBooking,
    bookings: [booking]
  });
  assert.strictEqual(reconciled.released, 1);

  const refreshed = await bookingModel.findById(booking.id);
  assert.strictEqual(refreshed.status, 'expired');

  const auditEvent = await findAuditEventByTypeAndSession('INVENTORY_RELEASED', sessionId);
  assert.ok(auditEvent);

  const reacquiredStatus = await service.execute('ACQUIRE', lockKey, 'session-b', 10);
  assert.strictEqual(reacquiredStatus, STATUS.ACQUIRED);
});

test('Test E - stress (200 sessions, one winner)', async () => {
  const lockKey = buildLockKey('stress');
  const count = Number(process.env.LOCK_STRESS_COUNT || 200);
  const sessionIds = Array.from({ length: count }, (_, i) => `session-${i}`);
  const ttlSeconds = 2;

  const results = await Promise.all(
    sessionIds.map((sessionId) => service.acquire(lockKey, sessionId, ttlSeconds))
  );

  const winners = results.filter(Boolean).length;
  assert.strictEqual(winners, 1);

  await new Promise((resolve) => setTimeout(resolve, (ttlSeconds + 1) * 1000));

  const exists = await client.exists(lockKey);
  assert.strictEqual(exists, 0);
});
