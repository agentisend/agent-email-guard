package emailguard

import (
	"fmt"
	"strings"
	"testing"
)

func alertsTo(recipients []string, count int) []SendRecord {
	out := make([]SendRecord, count)
	for i := range out {
		out[i] = rec(strings.Join(recipients, ","), nil, fmt.Sprintf("Alert %d: %s on host %d", i, []string{"disk", "queue", "latency", "errors"}[i%4], i*13), fmt.Sprintf("Check %d crossed its threshold at step %d; %s %s region.", i, i*7919, repeat("z", i%9), []string{"north", "south", "east", "west"}[i%4]), NOW-(int64(count-i)*60_000))
	}
	return out
}

func TestSP04_NewRecipientPassesACollapsedKey(t *testing.T) {
	r := DetectLoop(alertsTo([]string{"owner@warmy.test"}, 30), cand("new-user@example.com", "Your sign-in code", "Your code is 481 902."), NOW, Loop{})
	if !r.Entropy.WindowCollapsed || r.Entropy.Flagged || r.Verdict != VerdictClean || r.Decision != nil {
		t.Fatalf("entropy = %+v verdict = %s", r.Entropy, r.Verdict)
	}
}

func TestSP04_HoldsTheNextSendToTheCollapsedInbox(t *testing.T) {
	r := DetectLoop(alertsTo([]string{"owner@warmy.test"}, 30), cand("owner@warmy.test", "Alert 30: new wording", "A different sentence entirely."), NOW, Loop{})
	if r.Verdict != VerdictEntropyCollapse || reason(r) != ReasonRecipientEntropyCollapse || r.Decision.Evidence["candidate_recipient_share"] != float64(1) {
		t.Fatalf("verdict = %s evidence = %v", r.Verdict, r.Decision.Evidence)
	}
}

func TestSP04_CountsEachAddressOnASend(t *testing.T) {
	w := alertsTo([]string{"owner@warmy.test", "cfo@warmy.test"}, 30)
	if _, d := RecipientEntropy(w); d != 2 {
		t.Fatalf("distinct = %d", d)
	}
	if v := DetectLoop(w, cand("owner@warmy.test", "Something else", "Unrelated copy."), NOW, Loop{}).Verdict; v != VerdictEntropyCollapse {
		t.Fatalf("verdict = %s", v)
	}
}

func TestSP04_HoldsACandidateReachingTheInboxThroughCc(t *testing.T) {
	r := DetectLoop(alertsTo([]string{"owner@warmy.test"}, 30), rec("new-user@example.com", []string{"owner@warmy.test"}, "Welcome", "Welcome aboard.", NOW), NOW, Loop{})
	if r.Verdict != VerdictEntropyCollapse {
		t.Fatalf("verdict = %s", r.Verdict)
	}
}

func TestSP04_ReadsCcRecipientsInTheWindow(t *testing.T) {
	w := alertsTo([]string{"ops-inbox@warmy.test"}, 30)
	for i := range w {
		to := fmt.Sprintf("rotating-%d@warmy.test", i%2)
		w[i] = rec(to, []string{"owner@warmy.test"}, "Alert", fmt.Sprintf("body %d", i), w[i].At)
	}
	if _, d := RecipientEntropy(w); d != 3 {
		t.Fatalf("distinct = %d", d)
	}
	if v := DetectLoop(w, cand("owner@warmy.test", "s", "b"), NOW, Loop{}).Verdict; v != VerdictEntropyCollapse {
		t.Fatalf("verdict = %s", v)
	}
}
