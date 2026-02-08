const crypto = require('crypto');
const { verifyNonce } = require('./replay_protection');
const { NonRetryableError } = require('../errors');

function normalizeHeader(headers, name) {
  if (!headers) return null;
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function verifyHmacSignature({ rawBody, signatureHeader, secret }) {
  if (!secret) {
    throw new NonRetryableError('Webhook secret missing', {
      code: 'WEBHOOK_SECRET_MISSING'
    });
  }
  if (!signatureHeader) {
    throw new NonRetryableError('Webhook signature missing', {
      code: 'WEBHOOK_SIGNATURE_MISSING'
    });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.replace('sha256=', '')
    : signatureHeader;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    throw new NonRetryableError('Webhook signature invalid', {
      code: 'WEBHOOK_SIGNATURE_INVALID'
    });
  }
  if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw new NonRetryableError('Webhook signature invalid', {
      code: 'WEBHOOK_SIGNATURE_INVALID'
    });
  }
  return true;
}

async function verifyWhatsAppWebhook({ rawBody, headers, secret, redisClient }) {
  const signature = normalizeHeader(headers, 'x-hub-signature-256');
  verifyHmacSignature({
    rawBody,
    signatureHeader: signature,
    secret
  });

  const timestamp = normalizeHeader(headers, 'x-wa-timestamp');
  const nonce = normalizeHeader(headers, 'x-wa-nonce');
  if (!timestamp) {
    throw new NonRetryableError('Missing webhook timestamp', {
      code: 'WEBHOOK_TIMESTAMP_MISSING'
    });
  }
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new NonRetryableError('Invalid webhook timestamp', {
      code: 'WEBHOOK_TIMESTAMP_INVALID'
    });
  }
  await verifyNonce({
    nonce,
    scope: 'whatsapp',
    ttlSeconds: 600,
    redisClient
  });
  return true;
}

module.exports = {
  verifyWhatsAppWebhook
};
