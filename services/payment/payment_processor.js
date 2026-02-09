const { InventoryLockService } = require('../redis/InventoryLockService');
const bookingModel = require('../../models/booking');
const auditEventModel = require('../../models/auditEvent');
const { getLockKeysForBooking, releaseLockKeys } = require('../inventoryLocking');

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
  const booking = await bookingModel.findById(bookingId);
  if (!booking) {
    throw new Error(`Booking ${bookingId} not found`);
  }
  if (bookingModel.normalizeStatus(booking.status) !== 'hold') {
    return { idempotent: true, bookingId, status: payload.status };
  }

  const normalizedStatus = normalizePaymentStatus(payload.status);
  const newBookingStatus = mapStatusToBooking(normalizedStatus);
  if (!newBookingStatus) {
    throw new Error(`Unsupported payment status: ${payload.status}`);
  }

  const lockKeys = getLockKeysForBooking(booking);
  const lockService = new InventoryLockService(redisClient);
  const updated = await bookingModel.transitionStatus(bookingId, newBookingStatus, {
    releaseInventoryLock: async () => {
      try {
        await releaseLockKeys(lockService, lockKeys, {
          bookingId,
          reason: 'payment'
        });
      } catch (error) {
        throw error;
      }
    }
  });
  if (!updated) {
    throw new Error(`Failed to update booking ${bookingId}`);
  }

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
        lockKeys
      }
    });
  } else if (newBookingStatus === 'confirmed') {
    await auditEventModel.create({
      event_type: 'PAYMENT_SUCCEEDED',
      session_id: sessionId,
      payload: {
        booking_id: bookingId,
        lockKeys
      }
    });
  }

  return { idempotent: false, bookingId, status: normalizedStatus };
}

module.exports = {
  processPaymentEvent
};
