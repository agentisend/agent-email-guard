package emailguard

import (
	"context"
	"fmt"
	"regexp"
	"testing"
)

// allRefusals collects every refusal and hold path the guard can produce.
func allRefusals(t *testing.T) []Decision {
	t.Helper()
	ctx := context.Background()
	var out []Decision
	add := func(d Decision, err error) {
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, d)
	}

	loopWindow := make([]SendRecord, 30)
	for i := range loopWindow {
		loopWindow[i] = rec("same@recipient.com", nil, "identical subject", fmt.Sprintf("body variant %d", i%3), NOW-(int64(30-i)*1000))
	}
	out = append(out, *DetectLoop(loopWindow, cand("same@recipient.com", "identical subject", "body variant 1"), NOW, Loop{}).Decision)
	one := make([]SendRecord, 25)
	for i := range one {
		one[i] = rec("one@x.com", nil, fmt.Sprintf("s%d", i), fmt.Sprintf("b %d", i), NOW-(int64(25-i)*100))
	}
	out = append(out, *DetectLoop(one, cand("one@x.com", "new", "new"), NOW, Loop{}).Decision)

	budget := New(Config{Budgets: Budgets{PerMonth: Limit(1)}})
	s := Send{Key: "a1", To: []string{"x@example.com"}}
	add(budget.Check(ctx, s))
	add(budget.Check(ctx, s))

	rate := New(Config{Rate: Rate{PerMinute: Limit(1)}})
	add(rate.Check(ctx, s))
	add(rate.Check(ctx, s))

	kill := New(Config{})
	_, _ = kill.KillSwitch().Pause(ctx, "why", "op")
	add(kill.Check(ctx, s))

	appr := New(Config{
		Approval: Approval{Recipients: []string{"@bigco.com"}, NewRecipients: true, RequireFor: func(_ context.Context, s Send) (bool, string) {
			return s.Subject == "wire transfer", "Wires need a person."
		}},
		Suppress: []string{"regulator@gov.example"},
	})
	add(appr.Check(ctx, Send{To: []string{"CEO@bigco.com"}}))
	add(appr.Check(ctx, Send{To: []string{"regulator@gov.example"}}))
	add(appr.Check(ctx, Send{To: []string{"new@person.com"}}))
	add(appr.Check(ctx, Send{To: []string{"new@person.com"}, Subject: "wire transfer"}))

	var blocked []Decision
	for _, d := range out {
		if d.Outcome != Allow {
			blocked = append(blocked, d)
		}
	}
	return blocked
}

func TestRefusalTokens_EveryBlockingSubsystemProducesOne(t *testing.T) {
	seen := map[Reason]bool{}
	refusals := allRefusals(t)
	for _, d := range refusals {
		seen[d.Reason] = true
	}
	for _, r := range []Reason{ReasonLoopRepetitionDetected, ReasonRecipientEntropyCollapse, ReasonAgentBudgetExceeded,
		ReasonRateCeilingExceeded, ReasonKillSwitchActive, ReasonRecipientSuppressed, ReasonRecipientRequiresApproval} {
		if !seen[r] {
			t.Errorf("no refusal with %s", r)
		}
	}
	if len(refusals) < 9 {
		t.Fatalf("only %d refusals", len(refusals))
	}
}

func TestRefusalTokens_EveryRefusalValidatesTheContract(t *testing.T) {
	bad := regexp.MustCompile(`\bundefined\b|\bnull\b|\bnil\b|\[object|%!`)
	for _, d := range allRefusals(t) {
		if !d.IsValid() {
			t.Errorf("contract violated: %+v", d)
		}
		if len(d.Message) <= 30 || bad.MatchString(d.Message) {
			t.Errorf("message not a plain sentence: %q", d.Message)
		}
	}
}

func TestRefusalTokens_HostedOnlyTokensAreAbsent(t *testing.T) {
	for _, r := range ReasonTokens {
		if r == "brand_impersonation" || r == "trust_paused" {
			t.Fatalf("hosted-only token %s in ReasonTokens", r)
		}
	}
	if len(ReasonTokens) != 8 {
		t.Fatalf("len = %d", len(ReasonTokens))
	}
}
