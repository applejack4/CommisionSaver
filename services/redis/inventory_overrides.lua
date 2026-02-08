-- Script: inventory_overrides_apply
-- KEYS[1] = blocked seat set key
-- ARGV[1] = action ("BLOCK" | "UNBLOCK")
-- ARGV[2..n] = seat numbers

local action = ARGV[1]
if not action or action == '' then
  return -1
end

local count = 0
if action == 'BLOCK' then
  for i = 2, #ARGV do
    count = count + redis.call('SADD', KEYS[1], ARGV[i])
  end
  return count
end

if action == 'UNBLOCK' then
  for i = 2, #ARGV do
    count = count + redis.call('SREM', KEYS[1], ARGV[i])
  end
  return count
end

return -2
