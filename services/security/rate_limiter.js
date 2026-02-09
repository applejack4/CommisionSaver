const { RetryableError } = require('../errors');

const buckets = new Map();

function buildKey({ scope, identifier }) {
  return `${scope}:${identifier}`;
}

function rateLimit({ scope, identifier, limit, windowMs }) {
  const now = Date.now();
  const key = buildKey({ scope, identifier });
  const entry = buckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  buckets.set(key, entry);
  if (entry.count > limit) {
    const error = new RetryableError('Rate limit exceeded', {
      code: 'RATE_LIMITED',
      retryAfterMs: Math.max(0, entry.resetAt - now)
    });
    throw error;
  }
  return {
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt
  };
}

module.exports = {
  rateLimit
};
