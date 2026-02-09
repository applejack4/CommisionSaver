const { createClient } = require('redis');
const { RetryableError, NonRetryableError } = require('../errors');
const { getRedisClient } = require('../redis/redis_client');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const DEFAULT_TTL_SECONDS = 300;

async function ensureRedisClient(existing) {
  if (existing) {
    return { client: existing, shouldClose: false };
  }
  const handle = await getRedisClient();
  return { client: handle.client, shouldClose: true, close: handle.close };
}

async function verifyNonce({ nonce, scope, ttlSeconds, redisClient }) {
  if (!nonce) {
    throw new NonRetryableError('Missing nonce', { code: 'NONCE_REQUIRED' });
  }
  if (process.env.REDIS_FORCE_UNAVAILABLE === '1') {
    throw new RetryableError('Replay protection unavailable', {
      code: 'REPLAY_UNAVAILABLE'
    });
  }
  const key = `replay:${scope}:${nonce}`;
  const { client, shouldClose, close } = await ensureRedisClient(redisClient);
  try {
    const result = await client.set(key, '1', {
      NX: true,
      EX: ttlSeconds || DEFAULT_TTL_SECONDS
    });
    if (result !== 'OK') {
      throw new NonRetryableError('Replay detected', { code: 'REPLAY_DETECTED' });
    }
    return true;
  } catch (error) {
    if (error instanceof NonRetryableError) {
      throw error;
    }
    throw new RetryableError('Replay protection unavailable', {
      code: 'REPLAY_UNAVAILABLE'
    });
  } finally {
    if (shouldClose) {
      if (close) {
        await close();
      } else {
        try {
          await client.quit();
        } catch (error) {
          client.disconnect();
        }
      }
    }
  }
}

module.exports = {
  verifyNonce
};
