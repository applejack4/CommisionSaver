const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { InventoryLockService, STATUS } = require('../services/redis/InventoryLockService');
const bookingModel = require('../models/booking');
const tripModel = require('../models/trip');
const { getDatabase } = require('../database');
const { processPaymentEvent } = require('../services/payment/payment_processor');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client;
let lockService;

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

before(async () => {
  client = createClient({ url: REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  lockService = new InventoryLockService(client);
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
  await client.flushDb();
});

test('E2E: lock -> payment fail -> release -> rebook succeeds', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const lockKey = `lock:seat:${trip.id}:${trip.journey_date}:${trip.departure_time}`;

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
  await bookingModel.updateStatus(bookingA.id, 'payment_pending');
  const bookingAState = await bookingModel.findById(bookingA.id);
  assert.strictEqual(bookingAState.status, 'payment_pending');

  const acquireB = await lockService.execute('ACQUIRE', lockKey, sessionB, 30);
  assert.strictEqual(acquireB, STATUS.LOCKED_BY_OTHER);

  const paymentFail = await processPaymentEvent(
    {
      gateway_event_id: `evt_fail_${bookingA.id}`,
      status: 'FAILED',
      metadata: { booking_id: bookingA.id }
    },
    { redisClient: client }
  );
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
  await bookingModel.updateStatus(bookingB.id, 'payment_pending');

  const paymentSuccess = await processPaymentEvent(
    {
      gateway_event_id: `evt_success_${bookingB.id}`,
      status: 'SUCCESS',
      metadata: { booking_id: bookingB.id }
    },
    { redisClient: client }
  );
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
