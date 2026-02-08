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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'B',location:'redis_client.js:27',message:'getRedisClient entry',data:{forceUnavailable:process.env.REDIS_FORCE_UNAVAILABLE === '1',circuitOpen:circuitOpen()},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run3',hypothesisId:'G',location:'redis_client.js:27',message:'redis client auth check',data:{hasUsername:Boolean(username),hasPassword:Boolean(password)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (password) {
      const authCommand = username
        ? ['AUTH', username, password]
        : ['AUTH', password];
      await client.sendCommand(authCommand);
    }
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run3',hypothesisId:'G',location:'redis_client.js:35',message:'redis client connected',data:{isOpen:client.isOpen,isReady:client.isReady},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    resetFailures();
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run3',hypothesisId:'G',location:'redis_client.js:41',message:'redis client connect failed',data:{name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
