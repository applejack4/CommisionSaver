const DEFAULT_THRESHOLDS = Object.freeze({
  booking_failures: 10,
  payment_webhook_duplicates: 25
});

const counters = new Map();
const timers = new Map();
let alertHook = null;
let thresholds = { ...DEFAULT_THRESHOLDS };

function increment(name, value = 1, tags = {}) {
  const key = JSON.stringify({ name, tags });
  const current = counters.get(key) || 0;
  const next = current + value;
  counters.set(key, next);
  if (thresholds[name] && next >= thresholds[name] && typeof alertHook === 'function') {
    alertHook({
      metric: name,
      value: next,
      tags
    });
  }
  return next;
}

function recordLatency(name, durationMs, tags = {}) {
  const key = JSON.stringify({ name, tags });
  const bucket = timers.get(key) || [];
  bucket.push(durationMs);
  timers.set(key, bucket);
  return durationMs;
}

function snapshot() {
  return {
    counters: Object.fromEntries(counters.entries()),
    timers: Object.fromEntries(
      Array.from(timers.entries()).map(([key, values]) => [
        key,
        { count: values.length, avg_ms: values.reduce((sum, v) => sum + v, 0) / values.length }
      ])
    )
  };
}

function reset() {
  counters.clear();
  timers.clear();
}

function setAlertHook(hook) {
  alertHook = hook;
}

function setThresholds(next) {
  thresholds = { ...thresholds, ...(next || {}) };
}

module.exports = {
  increment,
  recordLatency,
  snapshot,
  reset,
  setAlertHook,
  setThresholds
};
