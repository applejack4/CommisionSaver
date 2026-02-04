const { createClient } = require('redis');
const { processPaymentEvent } = require('./payment_processor');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

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

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Payment webhook error:', error.message);
    return res.status(500).json({ success: false });
  }
};

module.exports = paymentWebhookHandler;
