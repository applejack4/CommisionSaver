const express = require('express');
const router = express.Router();
const { withIdempotency } = require('../services/idempotency/with_idempotency');
const { RetryLaterError } = require('../services/idempotency/retry_later_error');
const { cancelBooking } = require('../services/booking/booking_cancellation_service');
const { rateLimit } = require('../services/security/rate_limiter');
const { verifyBookingToken } = require('../services/security/booking_tokens');
const { RetryableError } = require('../services/errors');
const { createLogger } = require('../services/observability/logger');
const logger = createLogger({ source: 'booking_cancel' });

function requireIdempotencyKey(req, res) {
  const key = req.get('X-Idempotency-Key') || req.body?.idempotency_key;
  if (!key) {
    res.status(400).json({
      success: false,
      error: 'IDEMPOTENCY_KEY_REQUIRED'
    });
    return null;
  }
  return key;
}

router.post('/:bookingId/cancel', async (req, res) => {
  try {
    try {
      rateLimit({
        scope: 'booking_cancel',
        identifier: req.ip,
        limit: Number.parseInt(process.env.RATE_LIMIT_CANCEL || '30', 10),
        windowMs: 60000
      });
    } catch (error) {
      const status = error instanceof RetryableError ? 429 : 400;
      return res.status(status).json({
        success: false,
        error: error.code || 'RATE_LIMITED'
      });
    }

    const bookingId = parseInt(req.params.bookingId, 10);
    if (Number.isNaN(bookingId)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_BOOKING_ID'
      });
    }

    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const { actor, cancellation_reason, customer_phone, operator_id, operator_phone, booking_token } = req.body || {};
    if (!actor) {
      return res.status(400).json({
        success: false,
        error: 'ACTOR_REQUIRED'
      });
    }
    if (!['customer', 'operator', 'admin'].includes(actor)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_ACTOR'
      });
    }

    if (actor === 'customer') {
      const token = req.get('X-Booking-Token') || booking_token;
      if (!verifyBookingToken(bookingId, token)) {
        return res.status(403).json({
          success: false,
          error: 'BOOKING_TOKEN_INVALID'
        });
      }
    }

    const handleOnce = async () => {
      const result = await cancelBooking({
        bookingId,
        actorType: actor,
        actorDetails: {
          customer_phone,
          operator_id,
          operator_phone
        },
        reason: cancellation_reason || null,
        idempotencyKey
      });

      return {
        success: true,
        booking: result.booking,
        cancellation: result.cancellation,
        idempotent: result.idempotent
      };
    };

    try {
      const response = await withIdempotency({
        source: 'booking',
        eventType: 'cancel',
        idempotencyKey,
        request: {
          bookingId,
          actor,
          cancellation_reason,
          customer_phone,
          operator_id,
          operator_phone
        },
        handler: handleOnce
      });
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof RetryLaterError) {
        return res.status(409).json({
          success: false,
          error: 'REQUEST_IN_PROGRESS'
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof RetryableError) {
      logger.warn('cancel_retryable_error', { error: error.message });
      return res.status(503).json({
        success: false,
        error: error.code || 'RETRY_LATER'
      });
    }
    const code = error.code || 'CANCEL_FAILED';
    const status =
      code === 'BOOKING_NOT_FOUND' ? 404 :
      code === 'BOOKING_NOT_CONFIRMED' ? 409 :
      code === 'BOOKING_OWNERSHIP_INVALID' ? 403 :
      code === 'BOOKING_LOCKED' ? 409 :
      500;
    res.status(status).json({
      success: false,
      error: code,
      details: error.message
    });
  }
});

module.exports = router;
