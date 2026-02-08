const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const storage = new AsyncLocalStorage();

function buildRequestId(existing) {
  if (existing && typeof existing === 'string') {
    return existing;
  }
  return randomUUID();
}

function withContext(context, handler) {
  return storage.run(context, handler);
}

function getContext() {
  return storage.getStore() || {};
}

function setContextValue(key, value) {
  const current = getContext();
  current[key] = value;
  return current;
}

function buildRequestContext(req, extras = {}) {
  return {
    request_id: buildRequestId(req.get('x-request-id')),
    source: extras.source || req.get('x-source') || req.baseUrl || 'http',
    actor_id: req.get('x-user-id') || null,
    booking_id: req.get('x-booking-id') || null,
    path: req.originalUrl || req.url,
    method: req.method,
    ...extras
  };
}

module.exports = {
  withContext,
  getContext,
  setContextValue,
  buildRequestContext,
  buildRequestId
};
