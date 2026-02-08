const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getDatabase } = require('../database');
const bookingModel = require('../models/booking');
const paymentWebhookHandler = require('../services/payment/payment_webhook_handler');
const {
  buildWebhookSignature,
  calculateCommission
} = require('../services/payment/reconciliation');
const { createRefund, getRefundedTotal } = require('../services/payment/refunds');

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

async function countAuditEvents({ source, eventType, idempotencyKey }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM audit_events
       WHERE source = ? AND event_type = ? AND idempotency_key = ?`,
      [source, eventType, idempotencyKey],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row?.count || 0);
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
});

test('duplicate webhook delivery', async () => {
  const db = await getDatabase();
  const operatorId = await createOperator(db, 'Operator P', `990${Date.now()}`);
  const routeId = await createRoute(db, operatorId, 'CityX', 'CityY');
  const tripId = await createTrip(db, routeId, '2031-01-10', '10:00');

  const booking = await bookingModel.create({
    customer_phone: `991${Date.now()}`,
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
  const nonce1 = `nonce_${Date.now()}_1`;
  const nonce2 = `nonce_${Date.now()}_2`;

  const req = {
    body: rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': signature,
      'x-nonce': nonce1
    }
  };

  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = secret;

  const res1 = buildRes();
  await paymentWebhookHandler(req, res1);

  const res2 = buildRes();
  const req2 = {
    body: rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': signature,
      'x-nonce': nonce2
    }
  };
  await paymentWebhookHandler(req2, res2);

  process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;

  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(
    await countAuditEvents({
      source: 'payment',
      eventType: 'payment_success',
      idempotencyKey: payload.gateway_event_id
    }),
    1
  );
});

test('partial refund correctness', async () => {
  const bookingId = `b_${Date.now()}`;
  const originalAmount = 10000;

  await createRefund({
    bookingId,
    originalAmount,
    amount: 4000,
    currency: 'INR',
    idempotencyKey: `refund-${bookingId}-1`
  });

  const totalRefunded = await getRefundedTotal(bookingId);
  assert.strictEqual(totalRefunded, 4000);

  await assert.rejects(
    () =>
      createRefund({
        bookingId,
        originalAmount,
        amount: 7000,
        currency: 'INR',
        idempotencyKey: `refund-${bookingId}-2`
      }),
    (error) => error?.code === 'OVER_REFUND'
  );
});

test('commission edge cases', () => {
  const zeroCommission = calculateCommission({ amount: 0, commissionBps: 500 });
  assert.strictEqual(zeroCommission.commission_amount, 0);
  assert.strictEqual(zeroCommission.operator_amount, 0);

  const roundedCommission = calculateCommission({ amount: 999, commissionBps: 250 });
  assert.strictEqual(roundedCommission.commission_amount, 25);
  assert.strictEqual(roundedCommission.operator_amount, 974);
});
