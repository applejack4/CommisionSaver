const { getRedisClient } = require('../redis/redis_client');
const bookingModel = require('../../models/booking');
const tripModel = require('../../models/trip');
const operatorModel = require('../../models/operator');
const cancellationModel = require('../../models/cancellation');
const auditEventModel = require('../../models/auditEvent');
const { InventoryLockService } = require('../redis/InventoryLockService');
const { releaseSeatsFromBooking } = require('../inventory/seat_inventory_service');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BOOKING_LOCK_TTL_SECONDS = 20;

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  return String(phoneNumber).replace(/[\s+\-()]/g, '');
}

async function validateActorOwnership(booking, actorType, actorDetails) {
  if (actorType === 'admin') {
    return { ok: true };
  }

  if (actorType === 'customer') {
    const customerPhone = normalizePhoneNumber(actorDetails?.customer_phone);
    const bookingPhone = normalizePhoneNumber(booking.customer_phone);
    if (!customerPhone || customerPhone !== bookingPhone) {
      return { ok: false, message: 'Customer does not own booking' };
    }
    return { ok: true };
  }

  if (actorType === 'operator') {
    let operatorId = actorDetails?.operator_id || null;
    if (!operatorId && actorDetails?.operator_phone) {
      const operator = await operatorModel.findByPhone(
        normalizePhoneNumber(actorDetails.operator_phone)
      );
      operatorId = operator?.id || null;
    }
    if (!operatorId) {
      return { ok: false, message: 'Operator identity required' };
    }
    const trip = await tripModel.findById(booking.trip_id);
    if (!trip || String(trip.operator_id) !== String(operatorId)) {
      return { ok: false, message: 'Operator does not own booking' };
    }
    return { ok: true, operatorId };
  }

  return { ok: false, message: 'Invalid actor type' };
}

async function cancelBooking({
  bookingId,
  actorType,
  actorDetails = {},
  reason = null,
  idempotencyKey = null
}) {
  const booking = await bookingModel.findById(bookingId);
  if (!booking) {
    const error = new Error('Booking not found');
    error.code = 'BOOKING_NOT_FOUND';
    throw error;
  }

  const ownership = await validateActorOwnership(booking, actorType, actorDetails);
  if (!ownership.ok) {
    const error = new Error(ownership.message || 'Ownership validation failed');
    error.code = 'BOOKING_OWNERSHIP_INVALID';
    throw error;
  }

  if (bookingModel.normalizeStatus(booking.status) === 'cancelled') {
    const existing = await cancellationModel.findByBookingId(booking.id);
    return {
      booking,
      cancellation: existing,
      idempotent: true
    };
  }

  if (bookingModel.normalizeStatus(booking.status) !== 'confirmed') {
    const error = new Error('Booking is not confirmed');
    error.code = 'BOOKING_NOT_CONFIRMED';
    throw error;
  }

  const lockKey = `lock:booking:${booking.id}:cancel`;
  const lockOwner = `cancel:${actorType}:${ownership.operatorId || actorDetails?.customer_phone || 'unknown'}`;

  let parsed = null;
  try {
    parsed = new URL(REDIS_URL);
  } catch (error) {}
  let redisHandle = null;
  let redisClient = null;
  try {
    redisHandle = await getRedisClient();
    redisClient = redisHandle.client;
  } catch (error) {
    throw error;
  }
  const lockService = new InventoryLockService(redisClient);

  let lockAcquired = false;
  try {
    lockAcquired = await lockService.acquire(lockKey, lockOwner, BOOKING_LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      const error = new Error('Booking is locked for cancellation');
      error.code = 'BOOKING_LOCKED';
      throw error;
    }

    const refreshed = await bookingModel.findById(booking.id);
    if (!refreshed) {
      const error = new Error('Booking not found');
      error.code = 'BOOKING_NOT_FOUND';
      throw error;
    }
    if (bookingModel.normalizeStatus(refreshed.status) === 'cancelled') {
      const existing = await cancellationModel.findByBookingId(refreshed.id);
      return {
        booking: refreshed,
        cancellation: existing,
        idempotent: true
      };
    }
    if (bookingModel.normalizeStatus(refreshed.status) !== 'confirmed') {
      const error = new Error('Booking is not confirmed');
      error.code = 'BOOKING_NOT_CONFIRMED';
      throw error;
    }

    const cancelledAt = new Date().toISOString();
    await bookingModel.transitionStatus(refreshed.id, 'cancelled');
    await bookingModel.setCancellationDetails(refreshed.id, {
      cancelled_at: cancelledAt,
      cancelled_by: actorType,
      cancellation_reason: reason
    });
    const updatedBooking = await bookingModel.findById(refreshed.id);

    const cancellation = await cancellationModel.createIfMissing({
      bookingId: refreshed.id,
      cancelledBy: actorType,
      cancellationReason: reason,
      actorId: ownership.operatorId || actorDetails?.customer_phone || null,
      cancelledAt
    });

    await releaseSeatsFromBooking({
      booking: refreshed,
      reason: 'cancel',
      redisClient
    });

    await auditEventModel.create({
      event_type: 'BOOKING_CANCELLED',
      session_id: `sess_${refreshed.id}`,
      operator_id: actorType === 'operator' ? ownership.operatorId : null,
      idempotency_key: idempotencyKey || null,
      payload: {
        booking_id: refreshed.id,
        cancelled_by: actorType,
        cancellation_reason: reason || null
      }
    });

    await auditEventModel.create({
      event_type: 'REFUND_REQUESTED',
      session_id: `sess_${refreshed.id}`,
      operator_id: actorType === 'operator' ? ownership.operatorId : null,
      idempotency_key: idempotencyKey || null,
      payload: {
        booking_id: refreshed.id
      }
    });

    return {
      booking: updatedBooking,
      cancellation,
      idempotent: false
    };
  } finally {
    if (lockAcquired) {
      try {
        await lockService.release(lockKey, lockOwner);
      } catch (error) {}
    }
    if (redisHandle) {
      await redisHandle.close();
    } else {
      try {
        await redisClient.quit();
      } catch (error) {
        redisClient.disconnect();
      }
    }
  }
}

module.exports = {
  cancelBooking
};
