const { createClient } = require('redis');
const { processPaymentEvent } = require('./payment_processor');
const { withIdempotency } = require('../idempotency/with_idempotency');
const { RetryLaterError } = require('../idempotency/retry_later_error');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

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

const paymentWebhookHandler = async (req, res) => {
  try {
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
        const redisClient = createClient({ url: REDIS_URL });
        await redisClient.connect();
        try {
          await processPaymentEvent(payload, { redisClient });
        } finally {
          try {
            await redisClient.quit();
          } catch (error) {
            redisClient.disconnect();
          }
        }
        return { success: true };
      }
    });

    return res.status(200).json(response || { success: true });
  } catch (error) {
    if (error instanceof RetryLaterError) {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: 'RETRY_LATER'
      });
    }
    console.error('Payment webhook error:', error.message);
    return res.status(500).json({ success: false });
  }
};

module.exports = paymentWebhookHandler;
