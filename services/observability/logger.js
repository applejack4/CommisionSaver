const { getContext } = require('./request_context');

const LEVELS = Object.freeze({
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal'
});

function buildPayload(level, message, fields = {}) {
  const context = getContext();
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
    ...fields
  };
}

function log(level, message, fields = {}) {
  const payload = buildPayload(level, message, fields);
  const line = JSON.stringify(payload);
  if (level === LEVELS.error || level === LEVELS.fatal) {
    console.error(line);
    return;
  }
  if (level === LEVELS.warn) {
    console.warn(line);
    return;
  }
  console.log(line);
}

function createLogger(defaultFields = {}) {
  return {
    info(message, fields = {}) {
      log(LEVELS.info, message, { ...defaultFields, ...fields });
    },
    warn(message, fields = {}) {
      log(LEVELS.warn, message, { ...defaultFields, ...fields });
    },
    error(message, fields = {}) {
      log(LEVELS.error, message, { ...defaultFields, ...fields });
    },
    fatal(message, fields = {}) {
      log(LEVELS.fatal, message, { ...defaultFields, ...fields });
    }
  };
}

module.exports = {
  LEVELS,
  log,
  createLogger
};
