const express = require('express');
const router = express.Router();
const { withIdempotency } = require('../services/idempotency/with_idempotency');
const { RetryLaterError } = require('../services/idempotency/retry_later_error');
const {
  blockSeats,
  unblockSeats
} = require('../services/inventory/seat_inventory_service');

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

function validatePayload(body) {
  const {
    route_id,
    trip_date,
    seat_numbers,
    actor
  } = body || {};
  if (!route_id || !trip_date || !Array.isArray(seat_numbers) || seat_numbers.length === 0 || !actor) {
    return { ok: false, message: 'route_id, trip_date, seat_numbers, and actor are required' };
  }
  if (!['operator', 'admin'].includes(actor)) {
    return { ok: false, message: 'actor must be operator or admin' };
  }
  return { ok: true };
}

router.post('/block', async (req, res) => {
  try {
    const payload = req.body || {};
    const validation = validatePayload(payload);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYLOAD',
        details: validation.message
      });
    }

    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const handleOnce = async () => {
      const result = await blockSeats({
        routeId: payload.route_id,
        tripDate: payload.trip_date,
        seatNumbers: payload.seat_numbers,
        reason: payload.reason || null,
        actorType: payload.actor,
        actorId: payload.actor_id || payload.operator_id || null,
        idempotencyKey
      });
      return { success: true, override: result };
    };

    try {
      const response = await withIdempotency({
        source: 'inventory',
        eventType: 'block',
        idempotencyKey,
        request: payload,
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
    const status = error.code === 'SEAT_ALREADY_CONFIRMED' ? 409 : 500;
    res.status(status).json({
      success: false,
      error: error.code || 'BLOCK_FAILED',
      details: error.message
    });
  }
});

router.post('/unblock', async (req, res) => {
  try {
    const payload = req.body || {};
    const validation = validatePayload(payload);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYLOAD',
        details: validation.message
      });
    }

    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const handleOnce = async () => {
      const result = await unblockSeats({
        routeId: payload.route_id,
        tripDate: payload.trip_date,
        seatNumbers: payload.seat_numbers,
        reason: payload.reason || null,
        actorType: payload.actor,
        actorId: payload.actor_id || payload.operator_id || null,
        idempotencyKey
      });
      return { success: true, override: result };
    };

    try {
      const response = await withIdempotency({
        source: 'inventory',
        eventType: 'unblock',
        idempotencyKey,
        request: payload,
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
    res.status(500).json({
      success: false,
      error: error.code || 'UNBLOCK_FAILED',
      details: error.message
    });
  }
});

module.exports = router;
