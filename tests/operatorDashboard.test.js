const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { getDatabase } = require('../database');
const bookingModel = require('../models/booking');
const {
  getDashboardBookings,
  getDashboardTrips
} = require('../services/operator/dashboard_service');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redisClient;

async function resetDashboardData() {
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

async function createOperator(db, name, phone) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO operators (name, phone_number, approved) VALUES (?, ?, 1)',
      [name, phone],
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

async function createRoute(db, operatorId, source, destination) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO routes (operator_id, source, destination, price) VALUES (?, ?, ?, ?)',
      [operatorId, source, destination, 500],
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

async function createTrip(db, routeId, date, time) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO trips (route_id, journey_date, departure_time, whatsapp_seat_quota) VALUES (?, ?, ?, ?)',
      [routeId, date, time, 5],
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

before(async () => {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', () => {});
  await redisClient.connect();
});

after(async () => {
  if (!redisClient) return;
  try {
    await redisClient.quit();
  } catch (error) {
    redisClient.disconnect();
  }
});

beforeEach(async () => {
  await resetDashboardData();
  await redisClient.flushDb();
});

test('operator isolation', async () => {
  const db = await getDatabase();
  const operatorA = await createOperator(db, 'Operator A', `900${Date.now()}`);
  const operatorB = await createOperator(db, 'Operator B', `901${Date.now()}`);

  const routeA = await createRoute(db, operatorA, 'CityA', 'CityB');
  const routeB = await createRoute(db, operatorB, 'CityC', 'CityD');

  const tripA = await createTrip(db, routeA, '2030-01-10', '10:00');
  const tripB = await createTrip(db, routeB, '2030-01-11', '11:00');

  await bookingModel.create({
    customer_phone: `910${Date.now()}`,
    trip_id: tripA,
    seat_count: 1,
    lock_key: `lock:trip:${tripA}:seat:1`
  });
  await bookingModel.create({
    customer_phone: `911${Date.now()}`,
    trip_id: tripB,
    seat_count: 1,
    lock_key: `lock:trip:${tripB}:seat:1`
  });

  const bookings = await getDashboardBookings({ operatorId: operatorA, limit: 10 });
  assert.strictEqual(bookings.length, 1);
  assert.strictEqual(bookings[0].trip_id, tripA);
});

test('concurrent lock visibility', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db, 'Operator C', `902${Date.now()}`);
  const routeId = await createRoute(db, operatorId, 'CityE', 'CityF');
  const tripId = await createTrip(db, routeId, '2030-02-10', '12:00');

  await redisClient.set(`lock:trip:${tripId}:seat:1`, 'session-a', { EX: 60 });
  await redisClient.set(`lock:trip:${tripId}:seat:2`, 'session-b', { EX: 60 });

  const trips = await getDashboardTrips({ operatorId, startDate: '2030-02-01', endDate: '2030-02-28' });
  assert.strictEqual(trips.length, 1);
  assert.strictEqual(trips[0].locks.length, 2);
});

test('stale lock handling', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db, 'Operator D', `903${Date.now()}`);
  const routeId = await createRoute(db, operatorId, 'CityG', 'CityH');
  const tripId = await createTrip(db, routeId, '2030-03-10', '13:00');

  await redisClient.set(`lock:trip:${tripId}:seat:3`, 'session-stale', { EX: 60 });

  const trips = await getDashboardTrips({ operatorId, startDate: '2030-03-01', endDate: '2030-03-31' });
  assert.strictEqual(trips.length, 1);
  assert.strictEqual(trips[0].locks.length, 1);
  assert.strictEqual(trips[0].locks[0].stale, true);
});
