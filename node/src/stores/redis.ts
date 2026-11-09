/**
 * Redis store (SPEC §6). Shared by every process that points at the same
 * Redis and namespace, in any language that follows the spec's data layout:
 *
 *   counter   STRING (INCRBY), PEXPIREAT at the period end
 *   window    ZSET   score = at, member = reservation id
 *   log       ZSET   score = at, member = <12 hex>|<JSON send record>
 *   state     STRING
 *
 * Each conditional step is one Lua script, so it is atomic on the server.
 * Pass an ioredis client, or anything with ioredis's `eval` signature
 * (`eval(script, numKeys, ...keysAndArgs)`); a node-redis v4 client can be
 * adapted in three lines (see README).
 */

import { SEND_LOG_CAP, type CounterResult, type GuardStore, type SendRecord, type WindowResult } from '../store.js';

export interface RedisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
}

const INCREMENT_WITH_CEILING = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if ARGV[2] ~= '' and cur + amount > tonumber(ARGV[2]) then
  return {0, cur}
end
local new = redis.call('INCRBY', KEYS[1], amount)
if ARGV[3] ~= '' then redis.call('PEXPIREAT', KEYS[1], ARGV[3]) end
return {1, new}
`;

const DECREMENT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or 'nil')
if cur == nil then return 0 end
local new = cur - tonumber(ARGV[1])
if new < 0 then new = 0 end
redis.call('SET', KEYS[1], new, 'KEEPTTL')
return new
`;

const WINDOW_ADD = `
local at = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. tostring(at - windowMs + 1))
local count = redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local oldestAt = oldest[2] or ''
if count >= tonumber(ARGV[4]) then
  return {0, count, oldestAt}
end
redis.call('ZADD', KEYS[1], at, ARGV[1])
redis.call('PEXPIRE', KEYS[1], windowMs)
if oldestAt == '' then oldestAt = ARGV[2] end
return {1, count + 1, oldestAt}
`;

const APPEND_SEND = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. tostring(tonumber(ARGV[1]) - tonumber(ARGV[3])))
local n = redis.call('ZCARD', KEYS[1])
local cap = tonumber(ARGV[4])
if n > cap then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - cap - 1) end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return n
`;

/** The JSON form of a send record shared across languages (SPEC §6.1). */
export function encodeRecord(r: SendRecord, nonce: string): string {
  return `${nonce}|${JSON.stringify({ to_line: r.toLine, recipients: r.recipients, subject: r.subject, body: r.body, at: r.at })}`;
}

export function decodeRecord(member: string): SendRecord {
  const raw = member.slice(member.indexOf('|') + 1);
  const o = JSON.parse(raw) as { to_line: string; recipients: string[]; subject: string; body: string; at: number };
  return { toLine: o.to_line, recipients: o.recipients, subject: o.subject, body: o.body, at: o.at };
}

export class RedisStore implements GuardStore {
  readonly #redis: RedisLike;

  constructor(redis: RedisLike) {
    this.#redis = redis;
  }

  async incrementWithCeiling(name: string, amount: number, ceiling: number | null, expiresAt: number | null): Promise<CounterResult> {
    const [ok, value] = (await this.#redis.eval(
      INCREMENT_WITH_CEILING,
      1,
      name,
      amount,
      ceiling === null ? '' : ceiling,
      expiresAt === null ? '' : expiresAt,
    )) as [number, number];
    return { ok: Number(ok) === 1, value: Number(value) };
  }

  async decrement(name: string, amount: number): Promise<void> {
    await this.#redis.eval(DECREMENT, 1, name, amount);
  }

  async getCounter(name: string): Promise<number> {
    return Number((await this.#redis.get(name)) ?? 0);
  }

  async windowAdd(name: string, member: string, at: number, windowMs: number, ceiling: number): Promise<WindowResult> {
    const [ok, count, oldest] = (await this.#redis.eval(WINDOW_ADD, 1, name, member, at, windowMs, ceiling)) as [
      number,
      number,
      string,
    ];
    return { ok: Number(ok) === 1, count: Number(count), oldestAt: oldest === '' || oldest === undefined ? null : Number(oldest) };
  }

  async windowRemove(name: string, member: string): Promise<void> {
    await this.#redis.eval(`return redis.call('ZREM', KEYS[1], ARGV[1])`, 1, name, member);
  }

  async appendSend(log: string, record: SendRecord, keepMs: number): Promise<void> {
    const nonce = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await this.#redis.eval(APPEND_SEND, 1, log, record.at, encodeRecord(record, nonce), keepMs, SEND_LOG_CAP);
  }

  async recentSends(log: string, since: number): Promise<SendRecord[]> {
    return (await this.#redis.zrangebyscore(log, since, '+inf')).map(decodeRecord);
  }

  async getState(name: string): Promise<string | null> {
    return this.#redis.get(name);
  }

  async setState(name: string, value: string | null): Promise<void> {
    if (value === null) await this.#redis.del(name);
    else await this.#redis.set(name, value);
  }
}

export function redisStore(redis: RedisLike): RedisStore {
  return new RedisStore(redis);
}
