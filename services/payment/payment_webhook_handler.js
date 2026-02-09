const { processPaymentEvent } = require('./payment_processor');
const { withIdempotency } = require('../idempotency/with_idempotency');
const { RetryLaterError } = require('../idempotency/retry_later_error');
const { verifyWebhookSignature } = require('./reconciliation');
const { verifyNonce } = require('../security/replay_protection');
const { rateLimit } = require('../security/rate_limiter');
const { RetryableError, NonRetryableError } = require('../errors');
const { createLogger } = require('../observability/logger');
const metrics = require('../observability/metrics');
const { getRedisClient } = require('../redis/redis_client');

const logger = createLogger({ source: 'payment_webhook' });

function derivePaymentEventType(payload) {
  const explicit = String(payload?.event_type || '').toLowerCase();
  if (['payment_success', 'payment_failed', 'refund'].includes(explicit)) {
    return explicit;
  }
  const status = String(payload?.status || '').trim().toUpperCase();
  if (status.includes('REFUND')) {
    return 'refund';
  }
  if (['SUCCESS', 'SUCCEEDED', 'PAID'].includes(status)) {
    return 'payment_success';
  }
  if (['FAILED', 'FAILURE', 'CANCELLED'].includes(status)) {
    return 'payment_failed';
  }
  return 'payment_failed';
}

function getHeader(req, name) {
  if (req && typeof req.get === 'function') {
    return req.get(name);
  }
  const headers = req?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

const paymentWebhookHandler = async (req, res) => {
  try {
    try {
      rateLimit({
        scope: 'payment_webhook',
        identifier: req.ip,
        limit: Number.parseInt(process.env.RATE_LIMIT_WEBHOOKS || '60', 10),
        windowMs: 60000
      });
    } catch (error) {
      const status = error instanceof RetryableError ? 429 : 400;
      return res.status(status).json({
        success: false,
        error: error.code || 'RATE_LIMITED'
      });
    }

    console.log(
      'Webhook body type:',
      Buffer.isBuffer(req.body) ? 'raw-buffer' : typeof req.body
    );

    const rawBody = req.body;
    let payload = null;

    if (Buffer.isBuffer(rawBody)) {
      const text = rawBody.toString('utf8').trim();
      if (text.length > 0) {
        payload = JSON.parse(text);
      }
    } else if (rawBody && typeof rawBody === 'object') {
      const hasKeys =
        Array.isArray(rawBody) ? rawBody.length > 0 : Object.keys(rawBody).length > 0;
      if (hasKeys) {
        payload = rawBody;
      }
    }

    if (!payload) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or empty webhook payload',
      });
    }


    const verification = verifyWebhookSignature({
      rawBody,
      headers: req.headers,
      secret: process.env.PAYMENT_WEBHOOK_SECRET
    });
    if (!verification.ok) {
      metrics.increment('booking_failures', 1, { source: 'payment_webhook' });
      return res.status(401).json({
        success: false,
        error: verification.error || 'WEBHOOK_SIGNATURE_INVALID'
      });
    }


    const redisHandle = await getRedisClient();
    const redisClient = redisHandle.client;
    try {
      const nonceHeader = getHeader(req, 'x-nonce');
      await verifyNonce({
        nonce: getHeader(req, 'x-nonce'),
        scope: 'payment',
        ttlSeconds: 600,
        redisClient
      });

      // IMPORTANT: Webhooks must respond quickly.
      // Heavy processing must move to async jobs later.
      console.log('Payment webhook received', {
        gateway_event_id: payload.gateway_event_id,
        status: payload.status,
        booking_id: payload?.metadata?.booking_id,
      });

      const gatewayEventId = payload.gateway_event_id;
      if (!gatewayEventId) {
        return res.status(400).json({
          success: false,
          error: 'Missing gateway_event_id in webhook payload',
        });
      }

      const eventType = derivePaymentEventType(payload);
      const response = await withIdempotency({
        source: 'payment',
        eventType,
        idempotencyKey: gatewayEventId,
        request: payload,
        handler: async () => {
          await processPaymentEvent(payload, { redisClient });
          return { success: true };
        }
      });

      metrics.increment('booking_success', 1, { source: 'payment_webhook' });
      return res.status(200).json(response || { success: true });
    } finally {
      await redisHandle.close();
    }
  } catch (error) {
    if (error instanceof RetryLaterError) {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: 'RETRY_LATER'
      });
    }
    if (error instanceof RetryableError) {
      logger.warn('payment_webhook_retryable_error', {
        error: error.message,
        code: error.code
      });
      return res.status(503).json({ success: false, error: error.code || 'RETRY_LATER' });
    }
    if (error instanceof NonRetryableError) {
      logger.warn('payment_webhook_rejected', {
        error: error.message,
        code: error.code
      });
      return res.status(401).json({ success: false, error: error.code || 'REJECTED' });
    }
    console.error('Payment webhook error:', error.message);
    return res.status(500).json({ success: false });
  }
};

module.exports = paymentWebhookHandler;
