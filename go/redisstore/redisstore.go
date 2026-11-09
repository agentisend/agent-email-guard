// Package redisstore is an emailguard.Store on Redis, so every process that shares
// one Redis shares budgets, rate windows, loop history and the kill switch.
// Each check-and-change step is one Lua script, so it is atomic on the
// server.
//
//	rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
//	g := emailguard.New(emailguard.Config{Store: redisstore.New(rdb), ...})
package redisstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/redis/go-redis/v9"
)

// Store implements emailguard.Store on a go-redis client (single node, Sentinel
// or Cluster; every script touches one key).
type Store struct {
	rdb redis.UniversalClient
}

// New returns a Store on rdb.
func New(rdb redis.UniversalClient) *Store { return &Store{rdb: rdb} }

var _ emailguard.Store = (*Store)(nil)

var incrScript = redis.NewScript(`
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if ARGV[2] ~= '' and cur + amount > tonumber(ARGV[2]) then
  return {0, cur}
end
local new = redis.call('INCRBY', KEYS[1], amount)
if ARGV[3] ~= '0' then redis.call('PEXPIREAT', KEYS[1], ARGV[3]) end
return {1, new}
`)

var decrScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local new = tonumber(cur) - tonumber(ARGV[1])
if new < 0 then new = 0 end
redis.call('SET', KEYS[1], new, 'KEEPTTL')
return new
`)

var windowScript = redis.NewScript(`
local at = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', at - windowMs)
local count = redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if count >= tonumber(ARGV[4]) then
  return {0, count, oldest[2] or ''}
end
redis.call('ZADD', KEYS[1], at, ARGV[1])
redis.call('PEXPIRE', KEYS[1], windowMs)
if oldest[2] == nil then oldest = {ARGV[1], ARGV[2]} end
return {1, count + 1, oldest[2]}
`)

var appendScript = redis.NewScript(`
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. tostring(tonumber(ARGV[1]) - tonumber(ARGV[3])))
local n = redis.call('ZCARD', KEYS[1])
local cap = tonumber(ARGV[4])
if n > cap then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - cap - 1) end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return n
`)

func toInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case string:
		n, _ := strconv.ParseFloat(x, 64)
		return int64(n)
	}
	return 0
}

// IncrementWithCeiling implements emailguard.Store.
func (s *Store) IncrementWithCeiling(ctx context.Context, name string, amount int64, ceiling *int64, expiresAt int64) (int64, bool, error) {
	c := ""
	if ceiling != nil {
		c = strconv.FormatInt(*ceiling, 10)
	}
	res, err := incrScript.Run(ctx, s.rdb, []string{name}, amount, c, expiresAt).Slice()
	if err != nil {
		return 0, false, err
	}
	return toInt(res[1]), toInt(res[0]) == 1, nil
}

// Decrement implements emailguard.Store.
func (s *Store) Decrement(ctx context.Context, name string, amount int64) error {
	return decrScript.Run(ctx, s.rdb, []string{name}, amount).Err()
}

// GetCounter implements emailguard.Store.
func (s *Store) GetCounter(ctx context.Context, name string) (int64, error) {
	v, err := s.rdb.Get(ctx, name).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return v, err
}

// WindowAdd implements emailguard.Store.
func (s *Store) WindowAdd(ctx context.Context, name, member string, at, windowMs, ceiling int64) (emailguard.WindowResult, error) {
	res, err := windowScript.Run(ctx, s.rdb, []string{name}, member, at, windowMs, ceiling).Slice()
	if err != nil {
		return emailguard.WindowResult{}, err
	}
	w := emailguard.WindowResult{OK: toInt(res[0]) == 1, Count: toInt(res[1])}
	if o, _ := res[2].(string); o != "" {
		w.OldestAt, w.HasOldest = toInt(o), true
	}
	return w, nil
}

// WindowRemove implements emailguard.Store.
func (s *Store) WindowRemove(ctx context.Context, name, member string) error {
	return s.rdb.ZRem(ctx, name, member).Err()
}

// AppendSend implements emailguard.Store. The log is a ZSET scored by
// send time; each member is "<12 hex>|<send record JSON>", the layout every
// port shares.
func (s *Store) AppendSend(ctx context.Context, log string, record emailguard.SendRecord, keepMs int64) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	member := hex.EncodeToString(nonce[:]) + "|" + string(raw)
	return appendScript.Run(ctx, s.rdb, []string{log}, record.At, member, keepMs, emailguard.SendLogCap).Err()
}

// RecentSends implements emailguard.Store.
func (s *Store) RecentSends(ctx context.Context, log string, since int64) ([]emailguard.SendRecord, error) {
	items, err := s.rdb.ZRangeByScore(ctx, log, &redis.ZRangeBy{Min: strconv.FormatInt(since, 10), Max: "+inf"}).Result()
	if err != nil {
		return nil, err
	}
	out := make([]emailguard.SendRecord, 0, len(items))
	for _, it := range items {
		var r emailguard.SendRecord
		if err := json.Unmarshal([]byte(it[strings.IndexByte(it, '|')+1:]), &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// GetState implements emailguard.Store.
func (s *Store) GetState(ctx context.Context, name string) (string, bool, error) {
	v, err := s.rdb.Get(ctx, name).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetState implements emailguard.Store.
func (s *Store) SetState(ctx context.Context, name string, value *string) error {
	if value == nil {
		return s.rdb.Del(ctx, name).Err()
	}
	return s.rdb.Set(ctx, name, *value, 0).Err()
}
