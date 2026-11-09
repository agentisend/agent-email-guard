"""Redis store: share budgets, the rate window, the loop log and the kill switch across processes.

``pip install "agent-email-guard[redis]"``::

    import redis
    from agent_email_guard import Guard
    from agent_email_guard.stores.redis import RedisStore

    guard = Guard(budgets={"per_day": 500}, store=RedisStore(redis.Redis.from_url("redis://localhost:6379/0")))

Every check-and-change is one Lua script, so it is atomic on the Redis server.
Use :class:`AsyncRedisStore` with ``redis.asyncio`` and :class:`~agent_email_guard.AsyncGuard`.
"""

from __future__ import annotations

import json
import secrets
from typing import Any, List, Optional

from ..loop import SendRecord
from .base import SEND_LOG_CAP, CounterResult, WindowResult

INCREMENT_WITH_CEILING = """
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
"""

DECREMENT = """
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local n = tonumber(v) - tonumber(ARGV[1])
if n < 0 then n = 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then
  redis.call('SET', KEYS[1], n, 'PX', ttl)
else
  redis.call('SET', KEYS[1], n)
end
return n
"""

WINDOW_ADD = """
local at = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', at - window)
local count = redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local oldest_at = -1
if oldest[2] then oldest_at = tonumber(oldest[2]) end
if count >= tonumber(ARGV[4]) then
  return {0, count, oldest_at}
end
redis.call('ZADD', KEYS[1], at, ARGV[1])
redis.call('PEXPIRE', KEYS[1], window)
if oldest_at < 0 then oldest_at = at end
return {1, count + 1, oldest_at}
"""

APPEND_SEND = """
local at = tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], at, ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. (at - tonumber(ARGV[3])))
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(tonumber(ARGV[4]) + 1))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 60000)
return 1
"""


def _member(record: SendRecord) -> str:
    # A unique prefix keeps two identical sends in the same millisecond apart.
    return secrets.token_hex(6) + "|" + json.dumps(record.to_dict(), separators=(",", ":"), ensure_ascii=False)


def _parse_member(raw: Any) -> SendRecord:
    text = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
    return SendRecord.from_dict(json.loads(text.split("|", 1)[1]))


def _opt(value: Optional[int]) -> str:
    return "" if value is None else str(int(value))


def _str(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    return raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)


def _window(res: List[Any]) -> WindowResult:
    oldest = int(res[2])
    return WindowResult(bool(int(res[0])), int(res[1]), None if oldest < 0 else oldest)


class RedisStore:
    """Sync store over a ``redis.Redis`` client. ``prefix`` is added before every key."""

    def __init__(self, client: Any, prefix: str = "") -> None:
        self.client = client
        self.prefix = prefix
        self._inc = client.register_script(INCREMENT_WITH_CEILING)
        self._dec = client.register_script(DECREMENT)
        self._win = client.register_script(WINDOW_ADD)
        self._log = client.register_script(APPEND_SEND)

    def _k(self, name: str) -> str:
        return self.prefix + name

    def increment_with_ceiling(self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]) -> CounterResult:
        ok, value = self._inc(keys=[self._k(name)], args=[amount, _opt(ceiling), _opt(expires_at)])
        return CounterResult(bool(int(ok)), int(value))

    def decrement(self, name: str, amount: int) -> None:
        self._dec(keys=[self._k(name)], args=[amount])

    def get_counter(self, name: str) -> int:
        return int(self.client.get(self._k(name)) or 0)

    def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        return _window(self._win(keys=[self._k(name)], args=[member, at, window_ms, ceiling]))

    def window_remove(self, name: str, member: str) -> None:
        self.client.zrem(self._k(name), member)

    def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        self._log(keys=[self._k(log)], args=[_member(record), record.at, keep_ms, SEND_LOG_CAP])

    def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        return [_parse_member(m) for m in self.client.zrangebyscore(self._k(log), since, "+inf")]

    def get_state(self, name: str) -> Optional[str]:
        return _str(self.client.get(self._k(name)))

    def set_state(self, name: str, value: Optional[str]) -> None:
        if value is None:
            self.client.delete(self._k(name))
        else:
            self.client.set(self._k(name), value)


class AsyncRedisStore:
    """Async store over a ``redis.asyncio.Redis`` client, for :class:`~agent_email_guard.AsyncGuard`."""

    def __init__(self, client: Any, prefix: str = "") -> None:
        self.client = client
        self.prefix = prefix
        self._inc = client.register_script(INCREMENT_WITH_CEILING)
        self._dec = client.register_script(DECREMENT)
        self._win = client.register_script(WINDOW_ADD)
        self._log = client.register_script(APPEND_SEND)

    def _k(self, name: str) -> str:
        return self.prefix + name

    async def increment_with_ceiling(self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]) -> CounterResult:
        ok, value = await self._inc(keys=[self._k(name)], args=[amount, _opt(ceiling), _opt(expires_at)])
        return CounterResult(bool(int(ok)), int(value))

    async def decrement(self, name: str, amount: int) -> None:
        await self._dec(keys=[self._k(name)], args=[amount])

    async def get_counter(self, name: str) -> int:
        return int(await self.client.get(self._k(name)) or 0)

    async def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        return _window(await self._win(keys=[self._k(name)], args=[member, at, window_ms, ceiling]))

    async def window_remove(self, name: str, member: str) -> None:
        await self.client.zrem(self._k(name), member)

    async def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        await self._log(keys=[self._k(log)], args=[_member(record), record.at, keep_ms, SEND_LOG_CAP])

    async def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        return [_parse_member(m) for m in await self.client.zrangebyscore(self._k(log), since, "+inf")]

    async def get_state(self, name: str) -> Optional[str]:
        return _str(await self.client.get(self._k(name)))

    async def set_state(self, name: str, value: Optional[str]) -> None:
        if value is None:
            await self.client.delete(self._k(name))
        else:
            await self.client.set(self._k(name), value)
