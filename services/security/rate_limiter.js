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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'A',location:'rate_limiter.js:18',message:'rate limit exceeded',data:{scope,limit,windowMs,count:entry.count},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
