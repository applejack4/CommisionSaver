const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'inventory_locks.lua');
const LUA_SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

const STATUS = {
  ACQUIRED: 1,
  ALREADY_OWNED: 2,
  LOCKED_BY_OTHER: 3,
  EXTENDED: 4,
  RELEASED: 5,
  NOT_OWNER: 6,
  NOT_FOUND: 7,
  INVALID_ACTION: 8,
  INVALID_ARGS: 9,
  INVALID_TTL: 10
};

class InventoryLockError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'InventoryLockError';
    this.code = code;
    this.status = status;
  }
}

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

  const sha = await loadScript(redisClient, script);
  try {
    return await redisClient.sendCommand(['EVALSHA', sha, keys.length, ...keys, ...args]);
  } catch (error) {
    if (isNoScriptError(error)) {
      return await redisClient.sendCommand(['EVAL', script, keys.length, ...keys, ...args]);
    }
    throw error;
  }
}

class InventoryLockService {
  constructor(redisClient) {
    this.redisClient = redisClient;
    this.scriptLoad = loadScript(this.redisClient, LUA_SCRIPT);
  }

  async execute(action, lockKey, sessionId, ttlSeconds) {
    await this.scriptLoad;
    const args = [action, sessionId];
    if (typeof ttlSeconds !== 'undefined') {
      args.push(ttlSeconds);
    }
    const result = await evalScript(this.redisClient, LUA_SCRIPT, [lockKey], args);
    return Number(result);
  }

  async acquire(lockKey, sessionId, ttlSeconds) {
    const status = await this.execute('ACQUIRE', lockKey, sessionId, ttlSeconds);
    if (status === STATUS.ACQUIRED || status === STATUS.ALREADY_OWNED) {
      return true;
    }
    if (status === STATUS.LOCKED_BY_OTHER || status === STATUS.NOT_FOUND) {
      return false;
    }
    if (status === STATUS.NOT_OWNER) {
      throw new InventoryLockError('NOT_OWNER', status);
    }
    if (status === STATUS.INVALID_ARGS) {
      throw new InventoryLockError('INVALID_ARGS', status);
    }
    if (status === STATUS.INVALID_TTL) {
      throw new InventoryLockError('INVALID_TTL', status);
    }
    throw new InventoryLockError('UNKNOWN_STATUS', status);
  }

  async extend(lockKey, sessionId, ttlSeconds) {
    const status = await this.execute('EXTEND', lockKey, sessionId, ttlSeconds);
    if (status === STATUS.EXTENDED) {
      return true;
    }
    if (status === STATUS.NOT_FOUND) {
      return false;
    }
    if (status === STATUS.NOT_OWNER) {
      throw new InventoryLockError('NOT_OWNER', status);
    }
    if (status === STATUS.INVALID_ARGS) {
      throw new InventoryLockError('INVALID_ARGS', status);
    }
    if (status === STATUS.INVALID_TTL) {
      throw new InventoryLockError('INVALID_TTL', status);
    }
    throw new InventoryLockError('UNKNOWN_STATUS', status);
  }

  async release(lockKey, sessionId) {
    const status = await this.execute('RELEASE', lockKey, sessionId);
    if (status === STATUS.RELEASED) {
      return true;
    }
    if (status === STATUS.NOT_FOUND) {
      return false;
    }
    if (status === STATUS.NOT_OWNER) {
      throw new InventoryLockError('NOT_OWNER', status);
    }
    if (status === STATUS.INVALID_ARGS) {
      throw new InventoryLockError('INVALID_ARGS', status);
    }
    throw new InventoryLockError('UNKNOWN_STATUS', status);
  }

  async expire(lockKey) {
    const status = await this.execute('EXPIRE', lockKey, '');
    if (status === STATUS.RELEASED) {
      return true;
    }
    if (status === STATUS.NOT_FOUND) {
      return false;
    }
    if (status === STATUS.INVALID_ARGS) {
      throw new InventoryLockError('INVALID_ARGS', status);
    }
    throw new InventoryLockError('UNKNOWN_STATUS', status);
  }
}

module.exports = {
  InventoryLockService,
  InventoryLockError,
  STATUS
};
