const { InventoryLockService } = require('../redis/InventoryLockService');
const bookingModel = require('../../models/booking');
const auditEventModel = require('../../models/auditEvent');
const { defaultLockKeyForBooking } = require('../inventoryLockReconciliation');

function normalizePaymentStatus(status) {
  if (!status) return null;
  return String(status).trim().toUpperCase();
}

function mapStatusToBooking(status) {
  if (['SUCCESS', 'SUCCEEDED', 'PAID'].includes(status)) {
    return 'confirmed';
  }
  if (['FAILED', 'FAILURE', 'CANCELLED'].includes(status)) {
    return 'expired';
  }
  return null;
}

async function processPaymentEvent(payload, { redisClient }) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payment payload is required');
  }
  if (!redisClient) {
    throw new Error('Redis client is required');
  }

  const bookingId = payload?.metadata?.booking_id || payload?.booking_id;
  if (!bookingId) {
    throw new Error('Missing booking_id in payment payload');
  }

  const gatewayEventId = payload.gateway_event_id;
  if (!gatewayEventId) {
    throw new Error('Missing gateway_event_id in payment payload');
  }

  const sessionId = `sess_${bookingId}`;
  const existing = await auditEventModel.findByIdempotencyKey(
    sessionId,
    gatewayEventId,
    'PAYMENT_WEBHOOK'
  );
  if (existing) {
    return { idempotent: true, bookingId, status: payload.status };
  }

  const booking = await bookingModel.findById(bookingId);
  if (!booking) {
    throw new Error(`Booking ${bookingId} not found`);
  }

  const normalizedStatus = normalizePaymentStatus(payload.status);
  const newBookingStatus = mapStatusToBooking(normalizedStatus);
  if (!newBookingStatus) {
    throw new Error(`Unsupported payment status: ${payload.status}`);
  }

  const updated = await bookingModel.updateStatus(bookingId, newBookingStatus);
  if (!updated) {
    throw new Error(`Failed to update booking ${bookingId}`);
  }

  const lockKey = defaultLockKeyForBooking(booking);
  const lockService = new InventoryLockService(redisClient);
  await lockService.expire(lockKey);

  await auditEventModel.create({
    event_type: 'PAYMENT_WEBHOOK',
    session_id: sessionId,
    idempotency_key: gatewayEventId,
    payload: {
      booking_id: bookingId,
      status: normalizedStatus
    }
  });

  if (newBookingStatus === 'expired') {
    await auditEventModel.create({
      event_type: 'INVENTORY_RELEASED',
      session_id: sessionId,
      payload: {
        booking_id: bookingId,
        lockKey
      }
    });
  } else if (newBookingStatus === 'confirmed') {
    await auditEventModel.create({
      event_type: 'PAYMENT_SUCCEEDED',
      session_id: sessionId,
      payload: {
        booking_id: bookingId,
        lockKey
      }
    });
  }

  return { idempotent: false, bookingId, status: normalizedStatus };
}

module.exports = {
  processPaymentEvent
};
