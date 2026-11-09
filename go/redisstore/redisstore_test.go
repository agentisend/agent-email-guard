package redisstore_test

import (
	"context"
	"os"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/agentisend/agent-email-guard/go/redisstore"
	"github.com/agentisend/agent-email-guard/go/storetest"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// TestContract runs the store contract on an in-process Redis (miniredis,
// which runs the Lua scripts). Set AGENT_GUARD_REDIS_ADDR to also run it
// against a real server; each subtest flushes database 15 there.
func TestContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) emailguard.Store {
		mr := miniredis.RunT(t)
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = rdb.Close() })
		return redisstore.New(rdb)
	})
}

func TestContractRealRedis(t *testing.T) {
	addr := os.Getenv("AGENT_GUARD_REDIS_ADDR")
	if addr == "" {
		t.Skip("AGENT_GUARD_REDIS_ADDR not set")
	}
	storetest.Run(t, func(t *testing.T) emailguard.Store {
		rdb := redis.NewClient(&redis.Options{Addr: addr, DB: 15})
		if err := rdb.FlushDB(context.Background()).Err(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = rdb.Close() })
		return redisstore.New(rdb)
	})
}
