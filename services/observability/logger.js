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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'W',location:'logger.js:27',message:'logger warn emitted',data:{message,fieldKeys:Object.keys(fields || {})},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
