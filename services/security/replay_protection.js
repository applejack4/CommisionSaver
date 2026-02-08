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
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'C',location:'replay_protection.js:16',message:'verifyNonce entry',data:{scope,hasNonce:Boolean(nonce),nonceLength:nonce?String(nonce).length:0,hasRedisClient:Boolean(redisClient)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!nonce) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'C',location:'replay_protection.js:14',message:'nonce missing',data:{scope},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw new NonRetryableError('Missing nonce', { code: 'NONCE_REQUIRED' });
  }
  if (process.env.REDIS_FORCE_UNAVAILABLE === '1') {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run2',hypothesisId:'C',location:'replay_protection.js:19',message:'replay protection forced unavailable',data:{scope},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw new RetryableError('Replay protection unavailable', {
      code: 'REPLAY_UNAVAILABLE'
    });
  }
  const key = `replay:${scope}:${nonce}`;
  const { client, shouldClose, close } = await ensureRedisClient(redisClient);
  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run3',hypothesisId:'H',location:'replay_protection.js:30',message:'replay protection client ready',data:{scope,hasClient:Boolean(client),isOpen:client?.isOpen,isReady:client?.isReady},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    const result = await client.set(key, '1', {
      NX: true,
      EX: ttlSeconds || DEFAULT_TTL_SECONDS
    });
    if (result !== 'OK') {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'C',location:'replay_protection.js:30',message:'nonce replay detected',data:{scope},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      throw new NonRetryableError('Replay detected', { code: 'REPLAY_DETECTED' });
    }
    return true;
  } catch (error) {
    if (error instanceof NonRetryableError) {
      throw error;
    }
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run2',hypothesisId:'C',location:'replay_protection.js:39',message:'replay protection error',data:{scope,name:error?.name,message:error?.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
