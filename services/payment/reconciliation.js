const crypto = require('crypto');
const { withIdempotency } = require('../idempotency/with_idempotency');

const PAYMENT_STATES = Object.freeze({
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED'
});

const PAYMENT_EVENTS = Object.freeze({
  SUCCEED: 'SUCCEED',
  FAIL: 'FAIL',
  REFUND: 'REFUND'
});

const PAYMENT_TRANSITIONS = Object.freeze({
  [PAYMENT_STATES.PENDING]: {
    [PAYMENT_EVENTS.SUCCEED]: PAYMENT_STATES.SUCCEEDED,
    [PAYMENT_EVENTS.FAIL]: PAYMENT_STATES.FAILED,
    [PAYMENT_EVENTS.REFUND]: PAYMENT_STATES.REFUNDED
  },
  [PAYMENT_STATES.SUCCEEDED]: {
    [PAYMENT_EVENTS.REFUND]: PAYMENT_STATES.REFUNDED
  },
  [PAYMENT_STATES.FAILED]: {},
  [PAYMENT_STATES.REFUNDED]: {}
});

function applyPaymentEvent(currentState, event) {
  const state = currentState || PAYMENT_STATES.PENDING;
  const nextState = PAYMENT_TRANSITIONS[state]?.[event];
  if (!nextState) {
    return { ok: false, state, error: 'INVALID_PAYMENT_TRANSITION' };
  }
  return { ok: true, state: nextState, error: null };
}

function normalizeHeader(headers, name) {
  if (!headers) return null;
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function buildWebhookSignature({ secret, timestamp, rawBody }) {
  const payload = `${timestamp}.${rawBody}`;
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

function verifyWebhookSignature({
  rawBody,
  headers,
  secret,
  toleranceSeconds = 300
}) {
  if (!secret) {
    return { ok: false, error: 'WEBHOOK_SECRET_MISSING' };
  }
  const timestamp = normalizeHeader(headers, 'x-timestamp');
  const signature = normalizeHeader(headers, 'x-signature');
  if (!timestamp || !signature) {
    return { ok: false, error: 'WEBHOOK_SIGNATURE_MISSING' };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: 'WEBHOOK_TIMESTAMP_INVALID' };
  }
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, error: 'WEBHOOK_TIMESTAMP_OUT_OF_RANGE' };
  }
  const raw =
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : JSON.stringify(rawBody || {});
  const expected = buildWebhookSignature({
    secret,
    timestamp,
    rawBody: raw
  });
  const provided = String(signature);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return { ok: false, error: 'WEBHOOK_SIGNATURE_INVALID' };
  }
  const match = crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  return match ? { ok: true } : { ok: false, error: 'WEBHOOK_SIGNATURE_INVALID' };
}

function calculateCommission({
  amount,
  commissionBps = Number.parseInt(process.env.COMMISSION_RATE_BPS || '500', 10)
}) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid amount for commission');
  }
  const bps = Number.isFinite(commissionBps) ? commissionBps : 0;
  const commission = Math.round((amount * bps) / 10000);
  return {
    commission_amount: commission,
    commission_bps: bps,
    operator_amount: Math.max(0, amount - commission)
  };
}

async function reconcileSettlement({
  bookingId,
  amount,
  currency = 'INR',
  commissionBps,
  idempotencyKey
}) {
  if (!bookingId) {
    throw new Error('bookingId is required for settlement');
  }
  const commission = calculateCommission({ amount, commissionBps });
  const payload = {
    booking_id: bookingId,
    amount,
    currency,
    ...commission
  };

  return withIdempotency({
    source: 'payment',
    eventType: 'settlement',
    idempotencyKey: idempotencyKey || `settlement:${bookingId}`,
    request: payload,
    handler: async () => payload
  });
}

module.exports = {
  PAYMENT_STATES,
  PAYMENT_EVENTS,
  applyPaymentEvent,
  buildWebhookSignature,
  verifyWebhookSignature,
  calculateCommission,
  reconcileSettlement
};
