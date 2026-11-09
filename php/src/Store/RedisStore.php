<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

use AgentiSend\AgentEmailGuard\SendRecord;

/**
 * A store in Redis, through phpredis (\Redis, \RedisCluster) or Predis. Every
 * worker pointed at the same Redis shares budgets, rate windows, send logs
 * and the kill switch.
 *
 * incrementWithCeiling() and windowAdd() are each one Lua script, so each is
 * atomic on the server (SPEC §6.2). Names and data layout are SPEC §6.3 and
 * §6.4, so guards in other languages on the same Redis and namespace share
 * one budget, rate window, send log and kill switch:
 *   counter  STRING  INCRBY, PEXPIREAT at period end
 *   window   ZSET    score = at, member = reservation id
 *   log      ZSET    score = at, member = <12 hex>|<send record JSON>
 *   state    STRING
 */
final class RedisStore implements Store
{
    private const INCREMENT = <<<'LUA'
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if ARGV[2] ~= '' and v + amount > tonumber(ARGV[2]) then
  return {0, v}
end
v = redis.call('INCRBY', KEYS[1], amount)
if ARGV[3] ~= '' then
  redis.call('PEXPIREAT', KEYS[1], ARGV[3])
end
return {1, v}
LUA;

    private const DECREMENT = <<<'LUA'
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local v = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if v < 0 then
  redis.call('INCRBY', KEYS[1], -v)
end
return 1
LUA;

    private const WINDOW_ADD = <<<'LUA'
local at = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local ceiling = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', at - windowMs)
local count = redis.call('ZCARD', KEYS[1])
local oldest = -1
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if first[2] then
  oldest = tonumber(first[2])
end
if count >= ceiling then
  return {0, count, oldest}
end
redis.call('ZADD', KEYS[1], at, ARGV[1])
redis.call('PEXPIRE', KEYS[1], windowMs)
if oldest == -1 then
  oldest = at
end
return {1, count + 1, oldest}
LUA;

    private const APPEND = <<<'LUA'
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. tostring(tonumber(ARGV[1]) - tonumber(ARGV[3])))
local n = redis.call('ZCARD', KEYS[1])
local cap = tonumber(ARGV[4])
if n > cap then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - cap - 1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
LUA;

    public function __construct(private readonly \Redis|\RedisCluster|\Predis\ClientInterface $client)
    {
    }

    public function incrementWithCeiling(string $name, int $amount, ?int $ceiling, ?int $expiresAt): CounterResult
    {
        $result = $this->script(self::INCREMENT, [$name], [
            (string) $amount,
            $ceiling === null ? '' : (string) $ceiling,
            $expiresAt === null ? '' : (string) $expiresAt,
        ]);
        return new CounterResult(self::int($result[0] ?? 0) === 1, self::int($result[1] ?? 0));
    }

    public function decrement(string $name, int $amount): void
    {
        $this->script(self::DECREMENT, [$name], [(string) $amount]);
    }

    public function getCounter(string $name): int
    {
        return self::int($this->call('get', [$name]));
    }

    public function windowAdd(string $name, string $member, int $at, int $windowMs, int $ceiling): WindowResult
    {
        $result = $this->script(self::WINDOW_ADD, [$name], [$member, (string) $at, (string) $windowMs, (string) $ceiling]);
        $oldest = self::int($result[2] ?? -1);
        return new WindowResult(self::int($result[0] ?? 0) === 1, self::int($result[1] ?? 0), $oldest < 0 ? null : $oldest);
    }

    public function windowRemove(string $name, string $member): void
    {
        $this->call('zRem', [$name, $member]);
    }

    /** SPEC §6.4: a ZSET scored by `at`; each member is `<12 lowercase hex>|<send record JSON>`. */
    public function appendSend(string $log, SendRecord $record, int $keepMs): void
    {
        $member = bin2hex(random_bytes(6)) . '|' . $record->toJson();
        $this->script(self::APPEND, [$log], [(string) $record->at, $member, (string) $keepMs, (string) self::SEND_LOG_CAP]);
    }

    public function recentSends(string $log, int $since): array
    {
        $raw = $this->call('zRangeByScore', [$log, (string) $since, '+inf']);
        $out = [];
        foreach (is_array($raw) ? $raw : [] as $member) {
            if (!is_string($member) || ($bar = strpos($member, '|')) === false) {
                continue;
            }
            $out[] = SendRecord::fromJson(substr($member, $bar + 1));
        }
        return $out;
    }

    public function getState(string $name): ?string
    {
        $value = $this->call('get', [$name]);
        return is_string($value) ? $value : null;
    }

    public function setState(string $name, ?string $value): void
    {
        if ($value === null) {
            $this->call('del', [$name]);
        } else {
            $this->call('set', [$name, $value]);
        }
    }

    /**
     * @param list<string> $keys
     * @param list<string> $args
     * @return array<array-key, mixed>
     */
    private function script(string $lua, array $keys, array $args): array
    {
        if ($this->client instanceof \Predis\ClientInterface) {
            $result = $this->client->eval($lua, count($keys), ...$keys, ...$args);
        } else {
            $result = $this->client->eval($lua, [...$keys, ...$args], count($keys));
            if ($result === false && $this->client->getLastError() !== null) {
                throw new \RuntimeException('agent-email-guard Redis script failed: ' . $this->client->getLastError());
            }
        }
        return is_array($result) ? $result : [$result];
    }

    /** @param list<string|int> $args */
    private function call(string $method, array $args): mixed
    {
        if ($this->client instanceof \Predis\ClientInterface) {
            return $this->client->__call(strtolower($method), $args);
        }
        return $this->client->{$method}(...$args);
    }

    private static function int(mixed $value): int
    {
        return is_int($value) ? $value : (is_numeric($value) ? (int) $value : 0);
    }
}
