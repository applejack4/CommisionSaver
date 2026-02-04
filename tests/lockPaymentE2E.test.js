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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'A',location:'lockPaymentE2E.test.js:30',message:'ensureClientReady start',data:{hasClient:Boolean(client),isOpen:client?.isOpen,isReady:client?.isReady,hasRedisAuth:Boolean(redisAuth)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'A',location:'lockPaymentE2E.test.js:44',message:'ensureClientReady ready',data:{isOpen:client.isOpen,isReady:client.isReady,hasRedisAuth:Boolean(redisAuth)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (redisAuth) {
    const authCommand = redisAuth.username
      ? ['AUTH', redisAuth.username, redisAuth.password]
      : ['AUTH', redisAuth.password];
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'A',location:'lockPaymentE2E.test.js:52',message:'ensureClientReady auth',data:{hasUsername:Boolean(redisAuth.username),hasPassword:Boolean(redisAuth.password)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    await client.sendCommand(authCommand);
  }
  let pingResult = null;
  let pingError = null;
  try {
    pingResult = await client.sendCommand(['PING']);
  } catch (error) {
    pingError = { name: error?.name, message: error?.message };
  }
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'A',location:'lockPaymentE2E.test.js:60',message:'ensureClientReady ping',data:{pingResult,pingError},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  lockService = new InventoryLockService(client);
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'A',location:'lockPaymentE2E.test.js:69',message:'ensureClientReady done',data:{isOpen:client.isOpen,isReady:client.isReady,hasRedisAuth:Boolean(redisAuth)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'B',location:'lockPaymentE2E.test.js:86',message:'before parseRedisUrl',data:{parsedOk:Boolean(parsed),host:parsed?.host,port:parsed?.port,hasUsername:Boolean(parsed?.username),hasPassword:Boolean(parsed?.password)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  client = parsed
    ? createClient({
        socket: {
          host: parsed.host,
          port: Number(parsed.port)
        }
      })
    : createClient({ url: REDIS_URL });
  client.on('error', (error) => {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'C',location:'lockPaymentE2E.test.js:103',message:'redis client error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  });
  client.on('reconnecting', () => {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'C',location:'lockPaymentE2E.test.js:108',message:'redis client reconnecting',data:{},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  });
  client.on('end', () => {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'C',location:'lockPaymentE2E.test.js:113',message:'redis client end',data:{},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'D',location:'lockPaymentE2E.test.js:121',message:'beforeEach start',data:{hasRedisAuth:Boolean(redisAuth),isOpen:client?.isOpen,isReady:client?.isReady},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  await ensureClientReady();
  await resetBookingData();
  try {
    await client.flushDb();
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'D',location:'lockPaymentE2E.test.js:129',message:'beforeEach flushDb error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw error;
  }
});

test('E2E: lock -> payment fail -> release -> rebook succeeds', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const lockKey = `lock:seat:${trip.id}:${trip.journey_date}:${trip.departure_time}`;
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'F',location:'lockPaymentE2E.test.js:129',message:'pre-test bookings snapshot',data:{tripId,counts:(await bookingModel.findByTripId(tripId)).reduce((acc,booking)=>{acc.total+=1;acc[booking.status]=(acc[booking.status]||0)+1;return acc;},{total:0})},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

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

  let acquireB;
  try {
    acquireB = await lockService.execute('ACQUIRE', lockKey, sessionB, 30);
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'E',location:'lockPaymentE2E.test.js:150',message:'acquireB error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'E',location:'lockPaymentE2E.test.js:163',message:'paymentFail error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
  await bookingModel.updateStatus(bookingB.id, 'payment_pending');

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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'E',location:'lockPaymentE2E.test.js:196',message:'paymentSuccess error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw error;
  }
  assert.strictEqual(paymentSuccess.idempotent, false);

  const bookingBFinal = await bookingModel.findById(bookingB.id);
  assert.strictEqual(bookingBFinal.status, 'confirmed');
  assert.strictEqual(await client.exists(lockKey), 0);

  const allBookings = await bookingModel.findByTripId(tripId);
  const confirmed = allBookings.filter((booking) => booking.status === 'confirmed');
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'F',location:'lockPaymentE2E.test.js:265',message:'pre-assert bookings snapshot',data:{tripId,counts:allBookings.reduce((acc,booking)=>{acc.total+=1;acc[booking.status]=(acc[booking.status]||0)+1;return acc;},{total:0}),confirmedCount:confirmed.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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

