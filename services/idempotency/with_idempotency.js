const crypto = require('crypto');
const auditRepo = require('./audit_repo');
const { RetryLaterError } = require('./retry_later_error');
const metrics = require('../observability/metrics');

function stableStringify(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function hashRequest(request) {
  const payload = stableStringify(request);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function withIdempotency({
  source,
  eventType,
  idempotencyKey,
  request,
  handler
}) {
  if (!source || !eventType || !idempotencyKey) {
    throw new Error('Idempotency requires source, eventType, and idempotencyKey');
  }
  if (typeof handler !== 'function') {
    throw new Error('Idempotency handler must be a function');
  }

  const requestHash = hashRequest(request);
  const insertResult = await auditRepo.tryInsert({
    source,
    eventType,
    idempotencyKey,
    requestHash
  });

  if (!insertResult.inserted) {
    metrics.increment('idempotency_hits', 1, {
      source,
      eventType,
      status: insertResult.status || 'unknown'
    });
    if (source === 'payment') {
      metrics.increment('payment_webhook_duplicates', 1, {
        eventType
      });
    }
    if (insertResult.status === 'completed') {
      return insertResult.response_snapshot;
    }
    if (insertResult.status === 'started') {
      throw new RetryLaterError();
    }
    throw new RetryLaterError('Request is not ready to be retried');
  }

  try {
    const response = await handler();
    await auditRepo.markCompleted(insertResult.id, response);
    return response;
  } catch (error) {
    await auditRepo.markFailed(insertResult.id, error);
    throw error;
  }
}

module.exports = {
  withIdempotency
};
