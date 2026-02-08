const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { once } = require('node:events');
const bookingModel = require('../models/booking');
const tripModel = require('../models/trip');
const cancellationModel = require('../models/cancellation');
const { getDatabase } = require('../database');
const { InventoryLockService } = require('../services/redis/InventoryLockService');
const { acquireSeatLocks } = require('../services/inventory/seat_allocation_service');
const { blockSeats, unblockSeats } = require('../services/inventory/seat_inventory_service');
const { cancelBooking } = require('../services/booking/booking_cancellation_service');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redisClient;
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
  if (!redisClient.isOpen) {
    try {
      await redisClient.connect();
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'E',location:'cancellationOverrides.test.js:37',message:'redisClient connected',data:{isOpen:redisClient.isOpen,isReady:redisClient.isReady},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } catch (error) {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'F',location:'cancellationOverrides.test.js:41',message:'redisClient connect failed',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      throw error;
    }
  }
  if (!redisClient.isReady) {
    await Promise.race([
      once(redisClient, 'ready'),
      once(redisClient, 'error').then(([error]) => {
        throw error;
      })
    ]);
  }
  if (redisAuth && redisAuth.password) {
    const authCommand = redisAuth.username
      ? ['AUTH', redisAuth.username, redisAuth.password]
      : ['AUTH', redisAuth.password];
    await redisClient.sendCommand(authCommand);
  }
  lockService = new InventoryLockService(redisClient);
}

async function resetDb() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM bookings', (err) => {
        if (err) {
          reject(err);
          return;
        }
        db.run('DELETE FROM cancellations', (cancelErr) => {
          if (cancelErr) {
            reject(cancelErr);
            return;
          }
          db.run('DELETE FROM inventory_overrides', (overrideErr) => {
            if (overrideErr) {
              reject(overrideErr);
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
    });
  });
}

async function getAnyOperatorId() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM operators LIMIT 1', (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        reject(new Error('No operator available for tests'));
        return;
      }
      resolve(row.id);
    });
  });
}

async function createRouteAndTrip({ journeyDate, departureTime, seatQuota }) {
  const db = await getDatabase();
  const operatorId = await getAnyOperatorId();
  const source = `TestSource_${Date.now()}`;
  const destination = `TestDestination_${Date.now()}`;

  const routeId = await new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO routes (operator_id, source, destination, price) VALUES (?, ?, ?, ?)',
      [operatorId, source, destination, 100],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.lastID);
      }
    );
  });

  const trip = await tripModel.create({
    route_id: routeId,
    journey_date: journeyDate,
    departure_time: departureTime,
    whatsapp_seat_quota: seatQuota
  });

  return { trip, operatorId };
}

async function createConfirmedBooking(trip, seatNumbers) {
  const booking = await bookingModel.create({
    customer_name: 'Cancel Test',
    customer_phone: `999${Date.now()}`,
    trip_id: trip.id,
    seat_count: seatNumbers.length,
    seat_numbers: seatNumbers,
    hold_duration_minutes: 10,
    lock_key: `lock:trip:${trip.id}:seat:${seatNumbers[0]}`
  });
  const confirmed = await bookingModel.transitionStatus(booking.id, 'confirmed');
  return confirmed;
}

before(async () => {
  const parsed = parseRedisUrl();
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'G',location:'cancellationOverrides.test.js:109',message:'before parseRedisUrl',data:{hasRedisUrl:Boolean(REDIS_URL),host:parsed?.host||null,port:parsed?.port||null,hasUsername:Boolean(parsed?.username),hasPassword:Boolean(parsed?.password)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  redisAuth = parsed && parsed.password
    ? { username: parsed.username || null, password: parsed.password }
    : null;
  redisClient = parsed
    ? createClient({ socket: { host: parsed.host, port: Number(parsed.port) } })
    : createClient({ url: REDIS_URL });
  redisClient.on('error', () => {});
  await ensureClientReady();
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
  await ensureClientReady();
  try {
    await redisClient.flushDb();
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H',location:'cancellationOverrides.test.js:144',message:'flushDb ok',data:{},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H',location:'cancellationOverrides.test.js:148',message:'flushDb failed',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw error;
  }
  await resetDb();
});

test('Customer cancellation succeeds for confirmed booking', async () => {
  const { trip } = await createRouteAndTrip({
    journeyDate: '2030-01-01',
    departureTime: '09:00',
    seatQuota: 3
  });
  const confirmed = await createConfirmedBooking(trip, [1]);

  const result = await cancelBooking({
    bookingId: confirmed.id,
    actorType: 'customer',
    actorDetails: { customer_phone: confirmed.customer_phone },
    reason: 'Change of plans'
  });

  assert.strictEqual(result.booking.status, 'cancelled');
  const cancellation = await cancellationModel.findByBookingId(confirmed.id);
  assert.ok(cancellation);
  assert.strictEqual(cancellation.cancelled_by, 'customer');
});

test('Operator cancellation succeeds for route operator', async () => {
  const { trip, operatorId } = await createRouteAndTrip({
    journeyDate: '2030-02-01',
    departureTime: '10:00',
    seatQuota: 2
  });
  const confirmed = await createConfirmedBooking(trip, [1]);

  const result = await cancelBooking({
    bookingId: confirmed.id,
    actorType: 'operator',
    actorDetails: { operator_id: operatorId },
    reason: 'Schedule change'
  });

  assert.strictEqual(result.booking.status, 'cancelled');
});

test('Double cancellation is idempotent', async () => {
  const { trip } = await createRouteAndTrip({
    journeyDate: '2030-03-01',
    departureTime: '11:00',
    seatQuota: 2
  });
  const confirmed = await createConfirmedBooking(trip, [1]);

  const first = await cancelBooking({
    bookingId: confirmed.id,
    actorType: 'customer',
    actorDetails: { customer_phone: confirmed.customer_phone },
    reason: 'No longer needed'
  });
  const second = await cancelBooking({
    bookingId: confirmed.id,
    actorType: 'customer',
    actorDetails: { customer_phone: confirmed.customer_phone },
    reason: 'No longer needed'
  });

  assert.strictEqual(first.booking.status, 'cancelled');
  assert.strictEqual(second.idempotent, true);
  const cancellation = await cancellationModel.findByBookingId(confirmed.id);
  assert.ok(cancellation);
});

test('Blocked seat prevents booking allocation', async () => {
  const { trip, operatorId } = await createRouteAndTrip({
    journeyDate: '2030-04-01',
    departureTime: '12:00',
    seatQuota: 1
  });

  await blockSeats({
    routeId: trip.route_id,
    tripDate: trip.journey_date,
    seatNumbers: [1],
    reason: 'Maintenance',
    actorType: 'operator',
    actorId: operatorId
  });

  const allocation = await acquireSeatLocks({
    lockService,
    trip,
    seatCount: 1,
    sessionId: `sess_test_${Date.now()}`,
    ttlSeconds: 30
  });

  assert.strictEqual(allocation.acquired, false);
});

test('Unblocked seat allows booking allocation', async () => {
  const { trip, operatorId } = await createRouteAndTrip({
    journeyDate: '2030-05-01',
    departureTime: '13:00',
    seatQuota: 1
  });

  await blockSeats({
    routeId: trip.route_id,
    tripDate: trip.journey_date,
    seatNumbers: [1],
    reason: 'Maintenance',
    actorType: 'operator',
    actorId: operatorId
  });

  await unblockSeats({
    routeId: trip.route_id,
    tripDate: trip.journey_date,
    seatNumbers: [1],
    reason: 'Cleared',
    actorType: 'operator',
    actorId: operatorId
  });

  const allocation = await acquireSeatLocks({
    lockService,
    trip,
    seatCount: 1,
    sessionId: `sess_test_${Date.now()}`,
    ttlSeconds: 30
  });

  assert.strictEqual(allocation.acquired, true);
});

test('Block cannot override confirmed booking seats', async () => {
  const { trip, operatorId } = await createRouteAndTrip({
    journeyDate: '2030-06-01',
    departureTime: '14:00',
    seatQuota: 2
  });
  await createConfirmedBooking(trip, [1]);

  await assert.rejects(
    () =>
      blockSeats({
        routeId: trip.route_id,
        tripDate: trip.journey_date,
        seatNumbers: [1],
        reason: 'Attempted override',
        actorType: 'operator',
        actorId: operatorId
      }),
    /Seat/
  );
});
