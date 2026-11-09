package emailguard

import (
	"context"
	"testing"
)

func TestKillSwitch_RefusesWhilePausedWithWhoWhenWhy(t *testing.T) {
	clk := &msClock{1_000}
	g := New(Config{Clock: clk.now})
	ctx := context.Background()
	s := Send{Key: "agent", To: []string{"a@example.com"}}
	if d, _ := g.Check(ctx, s); !d.Allowed() {
		t.Fatal("should allow before pause")
	}
	if _, err := g.KillSwitch().Pause(ctx, "Agent was looping on one recipient.", "operator-7"); err != nil {
		t.Fatal(err)
	}
	clk.ms = 5_000
	d, _ := g.Check(ctx, s)
	if d.Outcome != Refuse || d.Reason != ReasonKillSwitchActive || d.Evidence["paused_by"] != "operator-7" ||
		d.Evidence["paused_at"] != int64(1_000) || d.Evidence["pause_reason"] != "Agent was looping on one recipient." || !d.IsValid() {
		t.Fatalf("decision = %+v", d)
	}
	if d, _ := g.Check(ctx, Send{Key: "other", To: []string{"a@example.com"}}); d.Reason != ReasonKillSwitchActive {
		t.Fatalf("the switch stops every key: %+v", d)
	}
}

func TestKillSwitch_NeverResumesOnATimer(t *testing.T) {
	clk := &msClock{1_000}
	g := New(Config{Clock: clk.now})
	ctx := context.Background()
	_, _ = g.KillSwitch().Pause(ctx, "Entropy collapse detected.", "trust-system")
	clk.ms += 365 * 24 * 3_600_000
	if st, _ := g.KillSwitch().State(ctx); !st.Paused {
		t.Fatal("resumed on its own")
	}
	if d, _ := g.Check(ctx, Send{To: []string{"a@example.com"}}); d.Reason != ReasonKillSwitchActive {
		t.Fatalf("decision = %+v", d)
	}
}

func TestKillSwitch_ResumesOnlyExplicitly(t *testing.T) {
	clk := &msClock{1_000}
	g := New(Config{Clock: clk.now})
	ctx := context.Background()
	ks := g.KillSwitch()
	_, _ = ks.Pause(ctx, "Loop suspected.", "operator-7")
	clk.ms = 86_400_000
	if st, _ := ks.State(ctx); !st.Paused || st.PausedBy != "operator-7" || st.PausedAt.UnixMilli() != 1_000 || st.Reason != "Loop suspected." {
		t.Fatalf("state = %+v", st)
	}
	if ok, err := ks.Resume(ctx, "operator-3"); !ok || err != nil {
		t.Fatalf("resume = %v %v", ok, err)
	}
	if d, _ := g.Check(ctx, Send{To: []string{"a@example.com"}}); !d.Allowed() {
		t.Fatalf("after resume: %+v", d)
	}
}

func TestKillSwitch_RedundantResumeReturnsFalse(t *testing.T) {
	g := New(Config{})
	if ok, err := g.KillSwitch().Resume(context.Background(), "op"); ok || err != nil {
		t.Fatalf("resume = %v %v", ok, err)
	}
}

func TestKillSwitch_RePauseReportsTheLatest(t *testing.T) {
	g := New(Config{})
	ctx := context.Background()
	ks := g.KillSwitch()
	_, _ = ks.Pause(ctx, "one", "a")
	_, _ = ks.Resume(ctx, "b")
	_, _ = ks.Pause(ctx, "three", "c")
	if d, _ := g.Check(ctx, Send{To: []string{"a@example.com"}}); d.Evidence["paused_by"] != "c" || d.Evidence["pause_reason"] != "three" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestKillSwitch_SharedThroughTheStore(t *testing.T) {
	store := NewMemoryStore()
	a, b := New(Config{Store: store}), New(Config{Store: store})
	ctx := context.Background()
	_, _ = a.KillSwitch().Pause(ctx, "stop", "")
	if d, _ := b.Check(ctx, Send{To: []string{"x@example.com"}}); d.Reason != ReasonKillSwitchActive || d.Evidence["paused_by"] != "agent-email-guard" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestKillSwitch_ResumeKeepsAnAuditRecord(t *testing.T) {
	store := NewMemoryStore()
	clk := &msClock{1_000}
	g := New(Config{Store: store, Clock: clk.now})
	ctx := context.Background()
	_, _ = g.KillSwitch().Pause(ctx, "Loop.", "op-1")
	clk.ms = 9_000
	_, _ = g.KillSwitch().Resume(ctx, "op-2")
	raw, ok, _ := store.GetState(ctx, "agent-email-guard:kill:last_resume")
	want := `{"paused_at":1000,"paused_by":"op-1","reason":"Loop.","resumed_at":9000,"resumed_by":"op-2"}`
	if !ok || raw != want {
		t.Fatalf("last_resume = %s", raw)
	}
}
