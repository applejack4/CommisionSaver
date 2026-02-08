const { getDatabase } = require('../../database');
const bookingModel = require('../../models/booking');
const { buildWebhookSignature } = require('../../services/payment/reconciliation');
const metrics = require('../../services/observability/metrics');

const DEFAULT_REDIS_PASSWORD = 'mypassword';
const originalRedisPassword = process.env.REDIS_PASSWORD;
if (!originalRedisPassword) {
  process.env.REDIS_PASSWORD = DEFAULT_REDIS_PASSWORD;
}

function loadPaymentWebhookHandler() {
  delete require.cache[require.resolve('../../services/redis/redis_client')];
  delete require.cache[require.resolve('../../services/payment/payment_webhook_handler')];
  return require('../../services/payment/payment_webhook_handler');
}

let paymentWebhookHandler = loadPaymentWebhookHandler();

async function resetPaymentData() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM audit_events');
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

function buildRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

beforeEach(async () => {
  await resetPaymentData();
  metrics.reset();
  if (!process.env.REDIS_PASSWORD) {
    process.env.REDIS_PASSWORD = DEFAULT_REDIS_PASSWORD;
  }
  paymentWebhookHandler = loadPaymentWebhookHandler();
});

afterAll(() => {
  if (originalRedisPassword) {
    process.env.REDIS_PASSWORD = originalRedisPassword;
  } else {
    delete process.env.REDIS_PASSWORD;
  }
});

test('duplicate webhook delivery is idempotent', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db, 'Operator P', `995${Date.now()}`);
  const routeId = await createRoute(db, operatorId, 'CityX', 'CityY');
  const tripId = await createTrip(db, routeId, '2036-01-10', '10:00');

  const booking = await bookingModel.create({
    customer_phone: `996${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    hold_duration_minutes: 10
  });

  const payload = {
    gateway_event_id: `gw_${Date.now()}`,
    status: 'SUCCESS',
    metadata: { booking_id: booking.id }
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildWebhookSignature({
    secret,
    timestamp,
    rawBody: rawBody.toString('utf8')
  });

  const req1 = {
    body: rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': signature,
      'x-nonce': `nonce_${Date.now()}_1`
    }
  };
  const req2 = {
    body: rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': signature,
      'x-nonce': `nonce_${Date.now()}_2`
    }
  };

  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = secret;

  const res1 = buildRes();
  await paymentWebhookHandler(req1, res1);

  const res2 = buildRes();
  await paymentWebhookHandler(req2, res2);

  process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;

  expect(res1.statusCode).toBe(200);
  expect(res2.statusCode).toBe(200);
});

test('retry storm keeps booking consistent', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db, 'Operator Q', `997${Date.now()}`);
  const routeId = await createRoute(db, operatorId, 'CityZ', 'CityW');
  const tripId = await createTrip(db, routeId, '2036-02-10', '11:00');

  const booking = await bookingModel.create({
    customer_phone: `998${Date.now()}`,
    trip_id: tripId,
    seat_count: 1,
    hold_duration_minutes: 10
  });

  const payload = {
    gateway_event_id: `gw_${Date.now()}`,
    status: 'SUCCESS',
    metadata: { booking_id: booking.id }
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildWebhookSignature({
    secret,
    timestamp,
    rawBody: rawBody.toString('utf8')
  });

  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = secret;

  const requests = Array.from({ length: 20 }, (_, idx) => {
    const req = {
      body: rawBody,
      headers: {
        'x-timestamp': timestamp,
        'x-signature': signature,
        'x-nonce': `nonce_${Date.now()}_${idx}`
      }
    };
    const res = buildRes();
    return paymentWebhookHandler(req, res).then(() => res);
  });

  const responses = await Promise.all(requests);
  responses.forEach((res) => {
    expect([200, 409]).toContain(res.statusCode);
  });

  process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
});
