-- Inventory lock Lua scripts
-- Key format: use the exact Redis key format defined in ARCHITECTURE.md
-- session_id is the lock owner.

-- ---------------------------------------------------------------------------
-- Script: inventory_lock_acquire
-- KEYS[1] = inventory lock key (format per ARCHITECTURE.md)
-- ARGV[1] = session_id (lock owner)
-- ARGV[2] = ttl_seconds
-- Return codes:
--   1  = lock acquired
--   0  = lock already held
--  -1  = missing/invalid arguments
--  -2  = invalid ttl
-- ---------------------------------------------------------------------------
do
  local key = KEYS[1]
  local session_id = ARGV[1]
  local ttl_seconds = tonumber(ARGV[2])

  if not key or key == '' or not session_id or session_id == '' then
    return -1
  end

  if not ttl_seconds or ttl_seconds <= 0 then
    return -2
  end

  local result = redis.call('SET', key, session_id, 'NX', 'EX', ttl_seconds)
  if result then
    return 1
  end

  return 0
end

-- ---------------------------------------------------------------------------
-- Script: inventory_lock_release
-- KEYS[1] = inventory lock key (format per ARCHITECTURE.md)
-- ARGV[1] = session_id (lock owner)
-- Return codes:
--   1  = lock released
--   0  = lock not found
--  -1  = missing/invalid arguments
--  -2  = lock owned by different session
-- ---------------------------------------------------------------------------
do
  local key = KEYS[1]
  local session_id = ARGV[1]

  if not key or key == '' or not session_id or session_id == '' then
    return -1
  end

  local owner = redis.call('GET', key)
  if not owner then
    return 0
  end

  if owner ~= session_id then
    return -2
  end

  redis.call('DEL', key)
  return 1
end

-- ---------------------------------------------------------------------------
-- Script: inventory_lock_extend
-- KEYS[1] = inventory lock key (format per ARCHITECTURE.md)
-- ARGV[1] = session_id (lock owner)
-- ARGV[2] = ttl_seconds
-- Return codes:
--   1  = ttl extended
--   0  = lock not found
--  -1  = missing/invalid arguments
--  -2  = lock owned by different session
--  -3  = invalid ttl
-- ---------------------------------------------------------------------------
do
  local key = KEYS[1]
  local session_id = ARGV[1]
  local ttl_seconds = tonumber(ARGV[2])

  if not key or key == '' or not session_id or session_id == '' then
    return -1
  end

  if not ttl_seconds or ttl_seconds <= 0 then
    return -3
  end

  local owner = redis.call('GET', key)
  if not owner then
    return 0
  end

  if owner ~= session_id then
    return -2
  end

  redis.call('EXPIRE', key, ttl_seconds)
  return 1
end
