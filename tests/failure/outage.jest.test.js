const bookingModel = require('../../models/booking');
const paymentWebhookHandler = require('../../services/payment/payment_webhook_handler');
const { buildWebhookSignature } = require('../../services/payment/reconciliation');

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

test('database outage returns retryable error', async () => {
  const originalFlag = process.env.DB_FORCE_UNAVAILABLE;
  process.env.DB_FORCE_UNAVAILABLE = '1';

  await expect(
    bookingModel.create({
      customer_phone: '9990000000',
      trip_id: 1,
      seat_count: 1
    })
  ).rejects.toMatchObject({ name: 'RetryableError' });

  process.env.DB_FORCE_UNAVAILABLE = originalFlag;
});

test('redis outage makes payment webhook retryable', async () => {
  const originalFlag = process.env.REDIS_FORCE_UNAVAILABLE;
  process.env.REDIS_FORCE_UNAVAILABLE = '1';

  const payload = {
    gateway_event_id: `gw_${Date.now()}`,
    status: 'SUCCESS',
    metadata: { booking_id: 1 }
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildWebhookSignature({
    secret,
    timestamp,
    rawBody: rawBody.toString('utf8')
  });

  const req = {
    body: rawBody,
    headers: {
      'x-timestamp': timestamp,
      'x-signature': signature,
      'x-nonce': `nonce_${Date.now()}_outage`
    }
  };

  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = secret;

  const res = buildRes();
  await paymentWebhookHandler(req, res);
  expect(res.statusCode).toBe(503);

  process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  process.env.REDIS_FORCE_UNAVAILABLE = originalFlag;
});
