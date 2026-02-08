const { getDatabase } = require('../../database');
const { withIdempotency } = require('../idempotency/with_idempotency');

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid amount');
  }
  return amount;
}

async function getRefundedTotal(bookingId) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT response_snapshot
       FROM audit_events
       WHERE source = 'payment' AND event_type = 'refund'`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        const total = (rows || []).reduce((sum, row) => {
          try {
            const payload = row?.response_snapshot
              ? JSON.parse(row.response_snapshot)
              : null;
            if (payload?.booking_id !== bookingId) {
              return sum;
            }
            const amount = Number(payload?.amount || 0);
            return sum + (Number.isFinite(amount) ? amount : 0);
          } catch (error) {
            return sum;
          }
        }, 0);
        resolve(total);
      }
    );
  });
}

function ensureRefundWithinBalance({ originalAmount, alreadyRefunded, requestAmount }) {
  const original = normalizeAmount(originalAmount);
  const refunded = normalizeAmount(alreadyRefunded);
  const request = normalizeAmount(requestAmount);
  const remaining = Math.max(0, original - refunded);
  if (request === 0) {
    throw new Error('Refund amount must be positive');
  }
  if (request > remaining) {
    const error = new Error('Refund exceeds remaining balance');
    error.code = 'OVER_REFUND';
    throw error;
  }
  return { remaining, request };
}

async function createRefund({
  bookingId,
  originalAmount,
  amount,
  currency = 'INR',
  reason = null,
  idempotencyKey
}) {
  if (!bookingId) {
    throw new Error('bookingId is required');
  }
  const alreadyRefunded = await getRefundedTotal(bookingId);
  const { remaining, request } = ensureRefundWithinBalance({
    originalAmount,
    alreadyRefunded,
    requestAmount: amount
  });

  const refundPayload = {
    booking_id: bookingId,
    amount: request,
    currency,
    reason,
    remaining_after: Math.max(0, remaining - request)
  };

  return withIdempotency({
    source: 'payment',
    eventType: 'refund',
    idempotencyKey: idempotencyKey || `refund:${bookingId}:${request}`,
    request: refundPayload,
    handler: async () => refundPayload
  });
}

module.exports = {
  getRefundedTotal,
  ensureRefundWithinBalance,
  createRefund
};
