// Package storetest checks that an emailguard.Store keeps the contract: the atomic
// steps really are atomic, windows slide, logs trim. Run it against your own
// backend:
//
//	func TestMyStore(t *testing.T) {
//		storetest.Run(t, func(t *testing.T) emailguard.Store { return newMyStore(t) })
//	}
package storetest

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

// Run runs every check. newStore must return an empty store each call.
func Run(t *testing.T, newStore func(t *testing.T) emailguard.Store) {
	ctx := context.Background()
	ptr := func(n int64) *int64 { return &n }

	t.Run("IncrementWithCeiling", func(t *testing.T) {
		s := newStore(t)
		if v, ok, err := s.IncrementWithCeiling(ctx, "c", 2, ptr(3), 0); err != nil || !ok || v != 2 {
			t.Fatalf("first = %d %v %v", v, ok, err)
		}
		if v, ok, _ := s.IncrementWithCeiling(ctx, "c", 2, ptr(3), 0); ok || v != 2 {
			t.Fatalf("over the ceiling = %d %v", v, ok)
		}
		if v, ok, _ := s.IncrementWithCeiling(ctx, "c", 1, ptr(3), 0); !ok || v != 3 {
			t.Fatalf("to the ceiling = %d %v", v, ok)
		}
		if v, ok, _ := s.IncrementWithCeiling(ctx, "fresh", 5, ptr(4), 0); ok || v != 0 {
			t.Fatalf("a fresh counter over its ceiling = %d %v", v, ok)
		}
		if v, ok, _ := s.IncrementWithCeiling(ctx, "u", 7, nil, 0); !ok || v != 7 {
			t.Fatalf("no ceiling = %d %v", v, ok)
		}
		if v, ok, _ := s.IncrementWithCeiling(ctx, "z", 1, ptr(0), 0); ok || v != 0 {
			t.Fatalf("ceiling 0 = %d %v", v, ok)
		}
	})

	t.Run("DecrementNeverBelowZero", func(t *testing.T) {
		s := newStore(t)
		_, _, _ = s.IncrementWithCeiling(ctx, "c", 2, nil, 0)
		if err := s.Decrement(ctx, "c", 5); err != nil {
			t.Fatal(err)
		}
		if v, _ := s.GetCounter(ctx, "c"); v != 0 {
			t.Fatalf("value = %d", v)
		}
		if err := s.Decrement(ctx, "missing", 1); err != nil {
			t.Fatal(err)
		}
		if v, _ := s.GetCounter(ctx, "missing"); v != 0 {
			t.Fatalf("missing = %d", v)
		}
	})

	t.Run("ConcurrentIncrementsNeverOvershoot", func(t *testing.T) {
		s := newStore(t)
		var admitted atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, ok, err := s.IncrementWithCeiling(ctx, "race", 1, ptr(25), 0); err != nil {
					t.Error(err)
				} else if ok {
					admitted.Add(1)
				}
			}()
		}
		wg.Wait()
		if admitted.Load() != 25 {
			t.Fatalf("admitted %d of a ceiling of 25", admitted.Load())
		}
		if v, _ := s.GetCounter(ctx, "race"); v != 25 {
			t.Fatalf("value = %d", v)
		}
	})

	t.Run("WindowSlides", func(t *testing.T) {
		s := newStore(t)
		for i, at := range []int64{1000, 2000} {
			w, err := s.WindowAdd(ctx, "w", fmt.Sprint("m", i), at, 60_000, 2)
			if err != nil || !w.OK || w.Count != int64(i+1) || w.OldestAt != 1000 || !w.HasOldest {
				t.Fatalf("add %d = %+v %v", i, w, err)
			}
		}
		if w, _ := s.WindowAdd(ctx, "w", "m2", 3000, 60_000, 2); w.OK || w.Count != 2 || w.OldestAt != 1000 {
			t.Fatalf("full window = %+v", w)
		}
		// 61000 - 1000 >= 60000: the first member leaves.
		if w, _ := s.WindowAdd(ctx, "w", "m3", 61_000, 60_000, 2); !w.OK || w.Count != 2 || w.OldestAt != 2000 {
			t.Fatalf("after the first left = %+v", w)
		}
		if err := s.WindowRemove(ctx, "w", "m3"); err != nil {
			t.Fatal(err)
		}
		if w, _ := s.WindowAdd(ctx, "w", "m4", 61_001, 60_000, 2); !w.OK || w.Count != 2 {
			t.Fatalf("after remove = %+v", w)
		}
	})

	t.Run("ConcurrentWindowAddsNeverOvershoot", func(t *testing.T) {
		s := newStore(t)
		var admitted atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 60; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				w, err := s.WindowAdd(ctx, "wr", fmt.Sprint("m", i), 5000, 60_000, 10)
				if err != nil {
					t.Error(err)
				} else if w.OK {
					admitted.Add(1)
				}
			}(i)
		}
		wg.Wait()
		if admitted.Load() != 10 {
			t.Fatalf("admitted %d of a ceiling of 10", admitted.Load())
		}
	})

	t.Run("SendLog", func(t *testing.T) {
		s := newStore(t)
		for i := int64(0); i < 5; i++ {
			r := emailguard.SendRecord{ToLine: "a@x.com", Recipients: []string{"a@x.com", "b@x.com"}, Subject: "s", Body: "b", At: 1000 * i}
			if err := s.AppendSend(ctx, "log", r, 2500); err != nil {
				t.Fatal(err)
			}
		}
		got, err := s.RecentSends(ctx, "log", 2000)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 3 || got[0].At != 2000 || got[2].At != 4000 || len(got[0].Recipients) != 2 || got[0].ToLine != "a@x.com" {
			t.Fatalf("recent = %+v", got)
		}
		// Identical records are kept as separate sends.
		dup := emailguard.SendRecord{ToLine: "d", Recipients: []string{"d"}, At: 10}
		_ = s.AppendSend(ctx, "dup", dup, 1000)
		_ = s.AppendSend(ctx, "dup", dup, 1000)
		if got, _ := s.RecentSends(ctx, "dup", 0); len(got) != 2 {
			t.Fatalf("duplicates collapsed: %d", len(got))
		}
	})

	t.Run("State", func(t *testing.T) {
		s := newStore(t)
		if _, ok, err := s.GetState(ctx, "k"); ok || err != nil {
			t.Fatalf("unset = %v %v", ok, err)
		}
		v := `{"x":1}`
		_ = s.SetState(ctx, "k", &v)
		if got, ok, _ := s.GetState(ctx, "k"); !ok || got != v {
			t.Fatalf("got = %q %v", got, ok)
		}
		_ = s.SetState(ctx, "k", nil)
		if _, ok, _ := s.GetState(ctx, "k"); ok {
			t.Fatal("not deleted")
		}
	})

	t.Run("GuardBudgetRace", func(t *testing.T) {
		g := emailguard.New(emailguard.Config{Store: newStore(t), Budgets: emailguard.Budgets{PerDay: emailguard.Limit(20)}, Rate: emailguard.Rate{PerMinute: emailguard.Limit(1000)}})
		var admitted atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 80; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				d, err := g.Check(ctx, emailguard.Send{Key: "race", To: []string{"a@example.com"}})
				if err != nil {
					t.Error(err)
				} else if d.Allowed() {
					admitted.Add(1)
				}
			}()
		}
		wg.Wait()
		if admitted.Load() != 20 {
			t.Fatalf("admitted %d of a budget of 20", admitted.Load())
		}
	})
}
