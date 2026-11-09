package emailguard

import (
	"context"
	"strconv"
	"sync"
	"testing"
)

func checkMany(t *testing.T, g *Guard, n int, send Send) []Decision {
	t.Helper()
	out := make([]Decision, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			d, err := g.Check(context.Background(), send)
			if err != nil {
				t.Error(err)
			}
			out[i] = d
		}(i)
	}
	close(start)
	wg.Wait()
	return out
}

func budgetName(key, period string, now int64) string {
	start, _ := PeriodBounds(period, now)
	return "agent-email-guard:" + key + ":budget:" + period + ":" + strconv.FormatInt(start, 10)
}

func counter(t *testing.T, s Store, name string) int64 {
	t.Helper()
	n, err := s.GetCounter(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestB08_200ConcurrentChecksAgainstABudgetOf50AdmitExactly50(t *testing.T) {
	store := NewMemoryStore()
	clk := &msClock{NOW}
	g := New(Config{Budgets: Budgets{PerDay: Limit(50)}, Rate: Rate{PerMinute: Limit(10_000)}, Store: store, Clock: clk.now, Loop: Loop{Mode: LoopOff}})
	admitted, refused := 0, 0
	for _, d := range checkMany(t, g, 200, Send{Key: "agent-race", To: []string{"a@example.com"}}) {
		switch {
		case d.Allowed():
			admitted++
		case d.Reason == ReasonAgentBudgetExceeded:
			refused++
		}
	}
	if admitted != 50 || admitted+refused != 200 {
		t.Fatalf("admitted=%d refused=%d", admitted, refused)
	}
	if c := counter(t, store, budgetName("agent-race", "day", NOW)); c != 50 {
		t.Fatalf("counter = %d", c)
	}
}

func TestB08_RaceAcrossThreeWindowsLeavesNoPartialReservation(t *testing.T) {
	store := NewMemoryStore()
	clk := &msClock{NOW}
	g := New(Config{Budgets: Budgets{PerHour: Limit(30), PerDay: Limit(40), PerMonth: Limit(35)}, Rate: Rate{PerMinute: Limit(1000)}, Store: store, Clock: clk.now, Loop: Loop{Mode: LoopOff}})
	admitted := 0
	for _, d := range checkMany(t, g, 300, Send{Key: "k", To: []string{"a@example.com"}}) {
		if d.Allowed() {
			admitted++
		}
	}
	if admitted != 30 {
		t.Fatalf("admitted = %d", admitted)
	}
	for _, p := range []string{"hour", "day", "month"} {
		if c := counter(t, store, budgetName("k", p, NOW)); c != 30 {
			t.Fatalf("%s counter %d != 30: a refusal left a partial reservation", p, c)
		}
	}
	w, _ := store.WindowAdd(context.Background(), "agent-email-guard:k:rate", "probe", NOW, 60_000, 1_000_000)
	if w.Count-1 != 30 {
		t.Fatalf("rate window holds %d, want 30: budget refusals must give back their slot", w.Count-1)
	}
}

func TestB08_RefusalNamesTheTokenAndBudget(t *testing.T) {
	g := New(Config{Budgets: Budgets{PerDay: Limit(1)}})
	ctx := context.Background()
	s := Send{Key: "agent-drained", To: []string{"a@example.com"}}
	if d, _ := g.Check(ctx, s); !d.Allowed() {
		t.Fatalf("first = %+v", d)
	}
	d, _ := g.Check(ctx, s)
	if d.Outcome != Refuse || d.Reason != ReasonAgentBudgetExceeded || d.Evidence["budget"] != 1 || d.Evidence["period"] != "day" || !d.IsValid() {
		t.Fatalf("blocked = %+v", d)
	}
}

func TestB08_RateCeilingRefusesIndependentlyAndConsumesNoBudget(t *testing.T) {
	store := NewMemoryStore()
	clk := &msClock{NOW}
	g := New(Config{Budgets: Budgets{PerDay: Limit(1000)}, Rate: Rate{PerMinute: Limit(5)}, Store: store, Clock: clk.now, Loop: Loop{Mode: LoopOff}})
	ctx := context.Background()
	s := Send{Key: "agent-fast", To: []string{"a@example.com"}}
	for i := 0; i < 5; i++ {
		if d, _ := g.Check(ctx, s); !d.Allowed() {
			t.Fatalf("send %d: %+v", i, d)
		}
	}
	d, _ := g.Check(ctx, s)
	if d.Reason != ReasonRateCeilingExceeded || d.Evidence["sends_in_window"] != int64(5) || d.Evidence["ceiling_per_minute"] != 5 || d.Evidence["retry_after_seconds"] != 60 {
		t.Fatalf("sixth = %+v", d)
	}
	if c := counter(t, store, budgetName("agent-fast", "day", NOW)); c != 5 {
		t.Fatalf("budget consumed = %d, want 5", c)
	}
	clk.ms += 60_000
	if d, _ := g.Check(ctx, s); !d.Allowed() {
		t.Fatalf("after a minute: %+v", d)
	}
}

func TestB08_ReleaseHandsBackExactlyWhatWasReservedOnce(t *testing.T) {
	store := NewMemoryStore()
	clk := &msClock{NOW}
	g := New(Config{Budgets: Budgets{PerHour: Limit(2)}, Store: store, Clock: clk.now})
	ctx := context.Background()
	s := Send{To: []string{"a@example.com"}}
	d1, _ := g.Check(ctx, s)
	d2, _ := g.Check(ctx, s)
	if !d1.Allowed() || !d2.Allowed() {
		t.Fatal("both should be allowed")
	}
	_ = g.Release(ctx, d1)
	_ = g.Release(ctx, d1) // a second release gives back nothing more
	if c := counter(t, store, budgetName("default", "hour", NOW)); c != 1 {
		t.Fatalf("counter = %d, want 1", c)
	}
}
