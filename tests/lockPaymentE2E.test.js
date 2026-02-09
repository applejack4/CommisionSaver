const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { once } = require('node:events');
const { InventoryLockService, STATUS } = require('../services/redis/InventoryLockService');
const bookingModel = require('../models/booking');
const tripModel = require('../models/trip');
const { getDatabase } = require('../database');
const { processPaymentEvent } = require('../services/payment/payment_processor');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let client;
let lockService;
let redisAuth;

function parseRedisUrl() {
  try {
    const parsed = new URL(REDIS_URL);
    return {
      host: parsed.hostname,
      port: parsed.port || '6379',
      username: parsed.username || null,
      password: parsed.password || null
    };
  } catch (error) {
    return null;
  }
}

async function ensureClientReady() {
  if (!client) {
    throw new Error('Redis client not initialized in before()');
  }
  if (!client.isOpen) {
    await client.connect();
  }
  if (!client.isReady) {
    await Promise.race([
      once(client, 'ready'),
      once(client, 'error').then(([error]) => {
        throw error;
      })
    ]);
  }
  if (redisAuth) {
    const authCommand = redisAuth.username
      ? ['AUTH', redisAuth.username, redisAuth.password]
      : ['AUTH', redisAuth.password];
    await client.sendCommand(authCommand);
  }
  let pingResult = null;
  let pingError = null;
  try {
    pingResult = await client.sendCommand(['PING']);
  } catch (error) {
    pingError = { name: error?.name, message: error?.message };
  }
  lockService = new InventoryLockService(client);
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

async function findAuditEventsBySession(sessionId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM audit_events
       WHERE session_id = ?
       ORDER BY id ASC`,
      [sessionId],
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

async function resetBookingData() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM bookings', (bookingErr) => {
        if (bookingErr) {
          reject(bookingErr);
          return;
        }
        db.run('DELETE FROM audit_events', (auditErr) => {
          if (auditErr) {
            reject(auditErr);
            return;
          }
          resolve();
        });
      });
    });
  });
}

before(async () => {
  const parsed = parseRedisUrl();
  redisAuth = parsed && parsed.password
    ? { username: parsed.username || null, password: parsed.password }
    : null;
  client = parsed
    ? createClient({
        socket: {
          host: parsed.host,
          port: Number(parsed.port)
        }
      })
    : createClient({ url: REDIS_URL });
  client.on('error', (error) => {
  });
  client.on('reconnecting', () => {
  });
  client.on('end', () => {
  });
  await ensureClientReady();
});

after(async () => {
  if (!client) return;
  try {
    await client.quit();
  } catch (error) {
    client.disconnect();
  }
});

beforeEach(async () => {
  await ensureClientReady();
  await resetBookingData();
  try {
    await client.flushDb();
  } catch (error) {
    throw error;
  }
});

test('E2E: lock -> payment fail -> release -> rebook succeeds', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const lockKey = `lock:trip:${trip.id}:seat:1`;

  const sessionA = `sess_a_${Date.now()}`;
  const sessionB = `sess_b_${Date.now()}`;

  const acquireA = await lockService.execute('ACQUIRE', lockKey, sessionA, 30);
  assert.strictEqual(acquireA, STATUS.ACQUIRED);
  assert.strictEqual(await client.exists(lockKey), 1);

  const bookingA = await bookingModel.create({
    customer_name: 'E2E A',
    customer_phone: `900${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    hold_duration_minutes: 10,
    lock_key: lockKey
  });
  await bookingModel.updateStatus(bookingA.id, 'hold');
  const bookingAState = await bookingModel.findById(bookingA.id);
  assert.strictEqual(bookingAState.status, 'hold');

  let acquireB;
  try {
    acquireB = await lockService.execute('ACQUIRE', lockKey, sessionB, 30);
  } catch (error) {
    throw error;
  }
  assert.strictEqual(acquireB, STATUS.LOCKED_BY_OTHER);

  let paymentFail;
  try {
    paymentFail = await processPaymentEvent(
      {
        gateway_event_id: `evt_fail_${bookingA.id}`,
        status: 'FAILED',
        metadata: { booking_id: bookingA.id }
      },
      { redisClient: client }
    );
  } catch (error) {
    throw error;
  }
  assert.strictEqual(paymentFail.idempotent, false);
  assert.strictEqual(await client.exists(lockKey), 0);

  const bookingAAfter = await bookingModel.findById(bookingA.id);
  assert.notStrictEqual(bookingAAfter.status, 'confirmed');

  const acquireBRetry = await lockService.execute('ACQUIRE', lockKey, sessionB, 30);
  assert.strictEqual(acquireBRetry, STATUS.ACQUIRED);
  assert.strictEqual(await client.exists(lockKey), 1);

  const bookingB = await bookingModel.create({
    customer_name: 'E2E B',
    customer_phone: `901${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    hold_duration_minutes: 10,
    lock_key: lockKey
  });
  await bookingModel.updateStatus(bookingB.id, 'hold');

  let paymentSuccess;
  try {
    paymentSuccess = await processPaymentEvent(
      {
        gateway_event_id: `evt_success_${bookingB.id}`,
        status: 'SUCCESS',
        metadata: { booking_id: bookingB.id }
      },
      { redisClient: client }
    );
  } catch (error) {
    throw error;
  }
  assert.strictEqual(paymentSuccess.idempotent, false);

  const bookingBFinal = await bookingModel.findById(bookingB.id);
  assert.strictEqual(bookingBFinal.status, 'confirmed');
  assert.strictEqual(await client.exists(lockKey), 0);

  const allBookings = await bookingModel.findByTripId(tripId);
  const confirmed = allBookings.filter((booking) => booking.status === 'confirmed');
  assert.strictEqual(confirmed.length, 1);
  assert.strictEqual(confirmed[0].id, bookingB.id);

  const eventsA = await findAuditEventsBySession(`sess_${bookingA.id}`);
  const eventsB = await findAuditEventsBySession(`sess_${bookingB.id}`);
  assert.ok(eventsA.some((event) => event.event_type === 'INVENTORY_RELEASED'));
  assert.ok(eventsB.some((event) => event.event_type === 'PAYMENT_SUCCEEDED'));

  const idempotentRepeat = await processPaymentEvent(
    {
      gateway_event_id: `evt_success_${bookingB.id}`,
      status: 'SUCCESS',
      metadata: { booking_id: bookingB.id }
    },
    { redisClient: client }
  );
  assert.strictEqual(idempotentRepeat.idempotent, true);
});

test('E2E: multi-seat locks release on payment failure', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);

  const seatNumbers = [1, 2];
  const lockKeys = seatNumbers.map((seatNumber) => `lock:trip:${trip.id}:seat:${seatNumber}`);
  const sessionId = `sess_multi_${Date.now()}`;

  for (const lockKey of lockKeys) {
    const acquired = await lockService.execute('ACQUIRE', lockKey, sessionId, 30);
    assert.strictEqual(acquired, STATUS.ACQUIRED);
    assert.strictEqual(await client.exists(lockKey), 1);
  }

  const booking = await bookingModel.create({
    customer_name: 'E2E Multi',
    customer_phone: `902${Date.now()}`,
    trip_id: tripId,
    seat_count: seatNumbers.length,
    seat_numbers: seatNumbers,
    hold_duration_minutes: 10,
    lock_key: lockKeys[0],
    lock_keys: lockKeys
  });
  await bookingModel.updateStatus(booking.id, 'hold');

  const paymentFail = await processPaymentEvent(
    {
      gateway_event_id: `evt_fail_multi_${booking.id}`,
      status: 'FAILED',
      metadata: { booking_id: booking.id }
    },
    { redisClient: client }
  );
  assert.strictEqual(paymentFail.idempotent, false);

  for (const lockKey of lockKeys) {
    assert.strictEqual(await client.exists(lockKey), 0);
  }

  const updated = await bookingModel.findById(booking.id);
  assert.strictEqual(updated.status, 'expired');
});
