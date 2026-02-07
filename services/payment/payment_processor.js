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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'P',location:'payment_processor.js:39',message:'processPaymentEvent entry',data:{bookingId,gatewayEventId,status:payload?.status,redisIsOpen:redisClient?.isOpen,redisIsReady:redisClient?.isReady},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'P',location:'payment_processor.js:63',message:'processPaymentEvent expire start',data:{lockKeys,redisIsOpen:redisClient?.isOpen,redisIsReady:redisClient?.isReady},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      try {
        await releaseLockKeys(lockService, lockKeys, {
          bookingId,
          reason: 'payment'
        });
      } catch (error) {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'P',location:'payment_processor.js:69',message:'processPaymentEvent expire error',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        throw error;
      }
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'pre-fix',hypothesisId:'P',location:'payment_processor.js:73',message:'processPaymentEvent expire done',data:{lockKeys},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
