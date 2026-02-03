-- Inventory lock Lua script (single entry point)
-- Key format: lock:{resource_type}:{resource_id}:{date}:{slot_id}
-- Value: session_id (lock owner)

-- Numeric status codes (return values only).
local STATUS_ACQUIRED = 1
local STATUS_ALREADY_OWNED = 2
local STATUS_LOCKED_BY_OTHER = 3
local STATUS_EXTENDED = 4
local STATUS_RELEASED = 5
local STATUS_NOT_OWNER = 6
local STATUS_NOT_FOUND = 7
local STATUS_INVALID_ACTION = 8
local STATUS_INVALID_ARGS = 9
local STATUS_INVALID_TTL = 10

local action = ARGV[1]
local key = KEYS[1]

-- Common argument validation.
if not action or action == '' or not key or key == '' then
  return STATUS_INVALID_ARGS
end

-- ---------------------------------------------------------------------------
-- ACQUIRE: set key if missing; idempotent for same session_id.
-- ARGV[2] = session_id
-- ARGV[3] = ttl_seconds
-- ---------------------------------------------------------------------------
local function handle_acquire()
  local session_id = ARGV[2]
  local ttl_seconds = tonumber(ARGV[3])

  if not session_id or session_id == '' then
    return STATUS_INVALID_ARGS
  end
  if not ttl_seconds or ttl_seconds <= 0 then
    return STATUS_INVALID_TTL
  end

  local ok = redis.call('SET', key, session_id, 'NX', 'EX', ttl_seconds)
  if ok then
    return STATUS_ACQUIRED
  end

  local owner = redis.call('GET', key)
  if owner == session_id then
    return STATUS_ALREADY_OWNED
  end
  return STATUS_LOCKED_BY_OTHER
end

-- ---------------------------------------------------------------------------
-- EXTEND: refresh TTL only if owned by session_id.
-- ARGV[2] = session_id
-- ARGV[3] = ttl_seconds
-- ---------------------------------------------------------------------------
local function handle_extend()
  local session_id = ARGV[2]
  local ttl_seconds = tonumber(ARGV[3])

  if not session_id or session_id == '' then
    return STATUS_INVALID_ARGS
  end
  if not ttl_seconds or ttl_seconds <= 0 then
    return STATUS_INVALID_TTL
  end

  local owner = redis.call('GET', key)
  if not owner then
    return STATUS_NOT_FOUND
  end
  if owner ~= session_id then
    return STATUS_NOT_OWNER
  end

  local ttl = redis.call('TTL', key)
  if ttl < 0 then
    return STATUS_NOT_FOUND
  end

  redis.call('EXPIRE', key, ttl_seconds)
  return STATUS_EXTENDED
end

-- ---------------------------------------------------------------------------
-- RELEASE: delete key only if owned by session_id.
-- ARGV[2] = session_id
-- ---------------------------------------------------------------------------
local function handle_release()
  local session_id = ARGV[2]

  if not session_id or session_id == '' then
    return STATUS_INVALID_ARGS
  end

  local owner = redis.call('GET', key)
  if not owner then
    return STATUS_NOT_FOUND
  end
  if owner ~= session_id then
    return STATUS_NOT_OWNER
  end

  redis.call('DEL', key)
  return STATUS_RELEASED
end

-- ---------------------------------------------------------------------------
-- EXPIRE: delete key unconditionally; safe no-op if missing.
-- ---------------------------------------------------------------------------
local function handle_expire()
  local owner = redis.call('GET', key)
  if not owner then
    return STATUS_NOT_FOUND
  end

  redis.call('DEL', key)
  return STATUS_RELEASED
end

-- Single entry point routing by ARGV[1].
if action == 'ACQUIRE' then
  return handle_acquire()
elseif action == 'EXTEND' then
  return handle_extend()
elseif action == 'RELEASE' then
  return handle_release()
elseif action == 'EXPIRE' then
  return handle_expire()
end

return STATUS_INVALID_ACTION
