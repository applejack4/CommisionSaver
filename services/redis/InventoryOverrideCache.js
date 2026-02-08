const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'inventory_overrides.lua');
const LUA_SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

let scriptSha = null;
let scriptLoadPromise = null;

function isNoScriptError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('NOSCRIPT'));
}

async function loadScript(redisClient, script) {
  if (scriptSha) {
    return scriptSha;
  }

  if (!scriptLoadPromise) {
    scriptLoadPromise = redisClient
      .sendCommand(['SCRIPT', 'LOAD', script])
      .then((sha) => {
        scriptSha = sha;
        return sha;
      })
      .finally(() => {
        scriptLoadPromise = null;
      });
  }

  return scriptLoadPromise;
}

async function evalScript(redisClient, script, keys, args) {
  if (!redisClient || typeof redisClient.sendCommand !== 'function') {
    throw new Error('Redis client does not support sendCommand');
  }

  const serializedKeys = Array.isArray(keys) ? keys.map((key) => String(key)) : [];
  const serializedArgs = Array.isArray(args)
    ? args.map((arg) => (typeof arg === 'number' ? String(arg) : arg))
    : [];
  const keyCount = String(serializedKeys.length);

  const sha = await loadScript(redisClient, script);
  try {
    return await redisClient.sendCommand(['EVALSHA', sha, keyCount, ...serializedKeys, ...serializedArgs]);
  } catch (error) {
    if (isNoScriptError(error)) {
      return await redisClient.sendCommand(['EVAL', script, keyCount, ...serializedKeys, ...serializedArgs]);
    }
    throw error;
  }
}

class InventoryOverrideCache {
  constructor(redisClient) {
    this.redisClient = redisClient;
    this.scriptLoad = loadScript(this.redisClient, LUA_SCRIPT);
  }

  async apply(action, cacheKey, seatNumbers) {
    await this.scriptLoad;
    const seats = Array.isArray(seatNumbers) ? seatNumbers.map((seat) => String(seat)) : [];
    const result = await evalScript(this.redisClient, LUA_SCRIPT, [cacheKey], [action, ...seats]);
    return Number(result);
  }

  async block(cacheKey, seatNumbers) {
    return this.apply('BLOCK', cacheKey, seatNumbers);
  }

  async unblock(cacheKey, seatNumbers) {
    return this.apply('UNBLOCK', cacheKey, seatNumbers);
  }

  async getBlockedSeats(cacheKey) {
    if (!this.redisClient || typeof this.redisClient.sendCommand !== 'function') {
      throw new Error('Redis client does not support sendCommand');
    }
    const result = await this.redisClient.sendCommand(['SMEMBERS', cacheKey]);
    return Array.isArray(result) ? result.map((value) => Number(value)) : [];
  }
}

module.exports = {
  InventoryOverrideCache
};
