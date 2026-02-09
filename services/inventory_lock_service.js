const fs = require('fs');
const path = require('path');

class InventoryLockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryLockError';
    this.code = code;
    this.details = details;
  }
}

const SCRIPT_FILE_PATH = path.join(__dirname, 'redis', 'inventory_locks.lua');
const LUA_SOURCE = fs.readFileSync(SCRIPT_FILE_PATH, 'utf8');

function extractScript(luaSource, scriptName) {
  const marker = `-- Script: ${scriptName}`;
  const startIndex = luaSource.indexOf(marker);
  if (startIndex === -1) {
    throw new Error(`Lua script marker not found: ${scriptName}`);
  }

  const nextIndex = luaSource.indexOf('-- Script:', startIndex + marker.length);
  const block = nextIndex === -1 ? luaSource.slice(startIndex) : luaSource.slice(startIndex, nextIndex);
  const match = block.match(/do[\s\S]*end/);
  if (!match) {
    throw new Error(`Lua script body not found: ${scriptName}`);
  }

  return match[0];
}

const LUA_SCRIPTS = {
  acquire: extractScript(LUA_SOURCE, 'inventory_lock_acquire'),
  release: extractScript(LUA_SOURCE, 'inventory_lock_release'),
  extend: extractScript(LUA_SOURCE, 'inventory_lock_extend')
};

function normalizeArgs(lockKeyOrOptions, sessionId, ttlSeconds) {
  if (lockKeyOrOptions && typeof lockKeyOrOptions === 'object') {
    return {
      lockKey: lockKeyOrOptions.lockKey,
      sessionId: lockKeyOrOptions.sessionId,
      ttlSeconds: lockKeyOrOptions.ttlSeconds,
      metadata: lockKeyOrOptions.metadata
    };
  }

  return {
    lockKey: lockKeyOrOptions,
    sessionId,
    ttlSeconds,
    metadata: undefined
  };
}

const scriptCache = new Map();
const scriptLoadPromises = new Map();

function isNoScriptError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('NOSCRIPT'));
}

async function loadScript(redisClient, script) {
  if (scriptCache.has(script)) {
    return scriptCache.get(script);
  }

  if (scriptLoadPromises.has(script)) {
    return scriptLoadPromises.get(script);
  }

  const loadPromise = redisClient
    .sendCommand(['SCRIPT', 'LOAD', script])
    .then((sha) => {
      scriptCache.set(script, sha);
      return sha;
    })
    .finally(() => {
      scriptLoadPromises.delete(script);
    });

  scriptLoadPromises.set(script, loadPromise);
  return loadPromise;
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
  constructor(redisClient, eventBus = null) {
    this.redisClient = redisClient;
    this.eventBus = eventBus;
    this.scriptLoad = Promise.all(
      Object.values(LUA_SCRIPTS).map((script) => loadScript(this.redisClient, script))
    );
  }

  emitEvent(eventName, payload) {
    if (this.eventBus && typeof this.eventBus.emit === 'function') {
      this.eventBus.emit(eventName, payload);
    }
  }

  async acquireLock(lockKeyOrOptions, sessionId, ttlSeconds) {
    await this.scriptLoad;
    const { lockKey, sessionId: ownerId, ttlSeconds: ttl, metadata } = normalizeArgs(
      lockKeyOrOptions,
      sessionId,
      ttlSeconds
    );

    const result = await evalScript(
      this.redisClient,
      LUA_SCRIPTS.acquire,
      [lockKey],
      [ownerId, ttl]
    );

    const status = Number(result);
    if (status === 1) {
      this.emitEvent('INVENTORY_LOCKED', {
        lockKey,
        sessionId: ownerId,
        ttlSeconds: ttl,
        metadata
      });
      return { acquired: true };
    }

    if (status === 0) {
      throw new InventoryLockError('LOCK_ALREADY_HELD', 'Inventory lock already held', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -1) {
      throw new InventoryLockError('INVALID_ARGUMENT', 'Missing or invalid lock arguments', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -2) {
      throw new InventoryLockError('INVALID_TTL', 'Invalid lock TTL', {
        ttlSeconds: ttl
      });
    }

    throw new InventoryLockError('UNKNOWN_STATUS', 'Unexpected lock acquire status', {
      status
    });
  }

  async releaseLock(lockKeyOrOptions, sessionId) {
    await this.scriptLoad;
    const { lockKey, sessionId: ownerId, metadata } = normalizeArgs(
      lockKeyOrOptions,
      sessionId
    );

    const result = await evalScript(
      this.redisClient,
      LUA_SCRIPTS.release,
      [lockKey],
      [ownerId]
    );

    const status = Number(result);
    if (status === 1) {
      this.emitEvent('INVENTORY_RELEASED', {
        lockKey,
        sessionId: ownerId,
        metadata
      });
      return { released: true };
    }

    if (status === 0) {
      throw new InventoryLockError('LOCK_NOT_FOUND', 'Inventory lock not found', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -1) {
      throw new InventoryLockError('INVALID_ARGUMENT', 'Missing or invalid lock arguments', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -2) {
      throw new InventoryLockError('LOCK_NOT_OWNED', 'Inventory lock owned by different session', {
        lockKey,
        sessionId: ownerId
      });
    }

    throw new InventoryLockError('UNKNOWN_STATUS', 'Unexpected lock release status', {
      status
    });
  }

  async extendLock(lockKeyOrOptions, sessionId, ttlSeconds) {
    await this.scriptLoad;
    const { lockKey, sessionId: ownerId, ttlSeconds: ttl } = normalizeArgs(
      lockKeyOrOptions,
      sessionId,
      ttlSeconds
    );

    const result = await evalScript(
      this.redisClient,
      LUA_SCRIPTS.extend,
      [lockKey],
      [ownerId, ttl]
    );

    const status = Number(result);
    if (status === 1) {
      return { extended: true };
    }

    if (status === 0) {
      throw new InventoryLockError('LOCK_NOT_FOUND', 'Inventory lock not found', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -1) {
      throw new InventoryLockError('INVALID_ARGUMENT', 'Missing or invalid lock arguments', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -2) {
      throw new InventoryLockError('LOCK_NOT_OWNED', 'Inventory lock owned by different session', {
        lockKey,
        sessionId: ownerId
      });
    }

    if (status === -3) {
      throw new InventoryLockError('INVALID_TTL', 'Invalid lock TTL', {
        ttlSeconds: ttl
      });
    }

    throw new InventoryLockError('UNKNOWN_STATUS', 'Unexpected lock extend status', {
      status
    });
  }
}

module.exports = {
  InventoryLockService,
  InventoryLockError
};
