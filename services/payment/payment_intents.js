const { withIdempotency } = require('../idempotency/with_idempotency');

const PAYMENT_INTENT_STATES = Object.freeze({
  CREATED: 'CREATED',
  SENT: 'SENT',
  EXPIRED: 'EXPIRED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED'
});

const PAYMENT_INTENT_EVENTS = Object.freeze({
  SEND: 'SEND',
  EXPIRE: 'EXPIRE',
  SUCCEED: 'SUCCEED',
  FAIL: 'FAIL'
});

const INTENT_TRANSITIONS = Object.freeze({
  [PAYMENT_INTENT_STATES.CREATED]: {
    [PAYMENT_INTENT_EVENTS.SEND]: PAYMENT_INTENT_STATES.SENT,
    [PAYMENT_INTENT_EVENTS.EXPIRE]: PAYMENT_INTENT_STATES.EXPIRED
  },
  [PAYMENT_INTENT_STATES.SENT]: {
    [PAYMENT_INTENT_EVENTS.SUCCEED]: PAYMENT_INTENT_STATES.SUCCEEDED,
    [PAYMENT_INTENT_EVENTS.FAIL]: PAYMENT_INTENT_STATES.FAILED,
    [PAYMENT_INTENT_EVENTS.EXPIRE]: PAYMENT_INTENT_STATES.EXPIRED
  },
  [PAYMENT_INTENT_STATES.SUCCEEDED]: {},
  [PAYMENT_INTENT_STATES.FAILED]: {},
  [PAYMENT_INTENT_STATES.EXPIRED]: {}
});

function applyIntentEvent(currentState, event) {
  const state = currentState || PAYMENT_INTENT_STATES.CREATED;
  const nextState = INTENT_TRANSITIONS[state]?.[event];
  if (!nextState) {
    return { ok: false, state, error: 'INVALID_INTENT_TRANSITION' };
  }
  return { ok: true, state: nextState, error: null };
}

async function createPaymentIntent({
  bookingId,
  amount,
  currency = 'INR',
  expiresAt,
  idempotencyKey,
  metadata = {}
}) {
  if (!bookingId) {
    throw new Error('bookingId is required');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }
  const intentId = `pi_${bookingId}_${Date.now()}`;
  const payload = {
    intent_id: intentId,
    booking_id: bookingId,
    amount,
    currency,
    expires_at: expiresAt || null,
    state: PAYMENT_INTENT_STATES.CREATED,
    metadata
  };

  return withIdempotency({
    source: 'payment',
    eventType: 'payment_intent_create',
    idempotencyKey: idempotencyKey || `intent:${bookingId}`,
    request: payload,
    handler: async () => payload
  });
}

module.exports = {
  PAYMENT_INTENT_STATES,
  PAYMENT_INTENT_EVENTS,
  applyIntentEvent,
  createPaymentIntent
};
