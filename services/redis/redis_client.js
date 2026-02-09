const { createClient } = require('redis');
const { RetryableError } = require('../errors');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const REDIS_USERNAME = process.env.REDIS_USERNAME || null;
const OPEN_DURATION_MS = Number.parseInt(process.env.REDIS_CIRCUIT_OPEN_MS || '5000', 10);

let failureCount = 0;
let openedUntil = 0;

function recordFailure() {
  failureCount += 1;
  openedUntil = Date.now() + OPEN_DURATION_MS;
}

function resetFailures() {
  failureCount = 0;
  openedUntil = 0;
}

function circuitOpen() {
  return openedUntil > Date.now();
}

async function getRedisClient() {
  if (process.env.REDIS_FORCE_UNAVAILABLE === '1' || circuitOpen()) {
    throw new RetryableError('Redis unavailable', {
      code: 'REDIS_UNAVAILABLE'
    });
  }
  const client = createClient({ url: REDIS_URL });
  try {
    await client.connect();
    let parsed = null;
    try {
      parsed = new URL(REDIS_URL);
    } catch (error) {}
    const username = parsed?.username || REDIS_USERNAME || null;
    const password = parsed?.password || REDIS_PASSWORD || null;
    if (password) {
      const authCommand = username
        ? ['AUTH', username, password]
        : ['AUTH', password];
      await client.sendCommand(authCommand);
    }
    resetFailures();
  } catch (error) {
    recordFailure();
    throw new RetryableError('Redis unavailable', {
      code: 'REDIS_UNAVAILABLE',
      cause: error?.message
    });
  }
  return {
    client,
    async close() {
      try {
        await client.quit();
      } catch (error) {
        client.disconnect();
      }
    }
  };
}

module.exports = {
  getRedisClient
};
