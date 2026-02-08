const { createClient } = require('redis');
const { InventoryLockService } = require('../../services/redis/InventoryLockService');
const { acquireSeatLocks } = require('../../services/inventory/seat_allocation_service');
const { getDatabase } = require('../../database');
const bookingModel = require('../../models/booking');
const { processPaymentEvent } = require('../../services/payment/payment_processor');
const { cancelBooking } = require('../../services/booking/booking_cancellation_service');

const DEFAULT_REDIS_PASSWORD = 'mypassword';
if (!process.env.REDIS_PASSWORD) {
  process.env.REDIS_PASSWORD = DEFAULT_REDIS_PASSWORD;
}

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const REDIS_USERNAME = process.env.REDIS_USERNAME || null;

let redisClient;
let lockService;

async function resetData() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM bookings');
      db.run('DELETE FROM trips');
      db.run('DELETE FROM routes');
      db.run('DELETE FROM operators', (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
}

async function createOperator(db) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO operators (name, phone_number, approved) VALUES (?, ?, 1)',
      ['Operator Concurrency', `980${Date.now()}`],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.lastID);
      }
    );
  });
}

async function createRoute(db, operatorId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO routes (operator_id, source, destination, price) VALUES (?, ?, ?, ?)',
      [operatorId, 'CityA', 'CityB', 500],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.lastID);
      }
    );
  });
}

async function createTrip(db, routeId, seatQuota = 1) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO trips (route_id, journey_date, departure_time, whatsapp_seat_quota) VALUES (?, ?, ?, ?)',
      [routeId, '2035-01-01', '08:00', seatQuota],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.lastID);
      }
    );
  });
}

beforeAll(async () => {
  redisClient = createClient({ url: REDIS_URL });
  await redisClient.connect();
  let parsed = null;
  try {
    parsed = new URL(REDIS_URL);
  } catch (error) {}
  const username = parsed?.username || REDIS_USERNAME || null;
  const password = parsed?.password || REDIS_PASSWORD || null;
  if (password) {
    const authCommand = username
      ? ['AUTH', username, password]
      : ['AUTH', password];
    await redisClient.sendCommand(authCommand);
  }
  lockService = new InventoryLockService(redisClient);
});

afterAll(async () => {
  if (!redisClient) return;
  try {
    await redisClient.quit();
  } catch (error) {
    redisClient.disconnect();
  }
});

beforeEach(async () => {
  await resetData();
  await redisClient.flushDb();
});

test('concurrent booking attempts do not double book seats', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db);
  const routeId = await createRoute(db, operatorId);
  const tripId = await createTrip(db, routeId, 1);
  const trip = {
    id: tripId,
    route_id: routeId,
    journey_date: '2035-01-01',
    whatsapp_seat_quota: 1
  };

  const attempts = Array.from({ length: 5 }, (_, idx) =>
    acquireSeatLocks({
      lockService,
      trip,
      seatCount: 1,
      sessionId: `sess_${idx}_${Date.now()}`,
      ttlSeconds: 60
    })
  );

  const results = await Promise.all(attempts);
  const acquired = results.filter((result) => result.acquired);
  expect(acquired.length).toBe(1);

  const keys = [];
  for await (const key of redisClient.scanIterator({ MATCH: `lock:trip:${tripId}:seat:*`, COUNT: 50 })) {
    keys.push(key);
  }
  expect(keys.length).toBe(1);

  const lockKeys = acquired[0].lockKeys;
  await Promise.all(lockKeys.map((key) => redisClient.del(key)));
});

test('cancellation vs payment confirmation race leaves consistent state', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db);
  const routeId = await createRoute(db, operatorId);
  const tripId = await createTrip(db, routeId, 1);
  const lockKey = `lock:trip:${tripId}:seat:1`;

  await redisClient.set(lockKey, 'session-race', { EX: 60 });

  const booking = await bookingModel.create({
    customer_phone: `981${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    lock_key: lockKey,
    lock_keys: [lockKey],
    seat_numbers: [1],
    hold_duration_minutes: 10
  });

  const payload = {
    gateway_event_id: `gw_${Date.now()}`,
    status: 'SUCCESS',
    metadata: { booking_id: booking.id }
  };

  const [paymentResult, cancelResult] = await Promise.allSettled([
    processPaymentEvent(payload, { redisClient }),
    cancelBooking({
      bookingId: booking.id,
      actorType: 'customer',
      actorDetails: { customer_phone: booking.customer_phone },
      reason: 'race-test',
      idempotencyKey: `race-${Date.now()}`
    })
  ]);

  expect(paymentResult.status).toBe('fulfilled');
  if (cancelResult.status === 'rejected') {
    expect(cancelResult.reason?.code).toBe('BOOKING_NOT_CONFIRMED');
  }

  const updated = await bookingModel.findById(booking.id);
  expect(updated.status).toBe('confirmed');
  const exists = await redisClient.exists(lockKey);
  expect(exists).toBe(0);
});
