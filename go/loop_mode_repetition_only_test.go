package emailguard

import (
	"fmt"
	"testing"
)

func collapsedAlerts(count int) []SendRecord {
	out := make([]SendRecord, count)
	for i := range out {
		out[i] = rec("owner@example.com", nil, fmt.Sprintf("Alert %d %s", i, repeat("abc", i%5)), fmt.Sprintf("Reading %d crossed %s in region %d.", i*17, repeat("z", i%7), i), NOW-(int64(count-i)*60_000))
	}
	return out
}

var ownerCandidate = cand("owner@example.com", "A new sentence", "Nothing like the alerts.")

func TestLoopMode_RepetitionOnlyIgnoresEntropyCollapse(t *testing.T) {
	r := DetectLoop(collapsedAlerts(30), ownerCandidate, NOW, Loop{Mode: LoopRepetitionOnly})
	if !r.Entropy.WindowCollapsed || r.Entropy.Flagged || r.Verdict != VerdictClean {
		t.Fatalf("entropy = %+v verdict = %s", r.Entropy, r.Verdict)
	}
}

func TestLoopMode_OffHoldsNothing(t *testing.T) {
	w := collapsedAlerts(4)
	for i := range w {
		w[i].Subject, w[i].Body = "same", "same body"
	}
	r := DetectLoop(w, cand("owner@example.com", "same", "same body"), NOW, Loop{Mode: LoopOff})
	if r.Verdict != VerdictClean || r.Repetition.Flagged {
		t.Fatalf("verdict = %s", r.Verdict)
	}
}

func TestLoopMode_FullStillHoldsDominantRecipient(t *testing.T) {
	if v := DetectLoop(collapsedAlerts(30), ownerCandidate, NOW, Loop{Mode: LoopFull}).Verdict; v != VerdictEntropyCollapse {
		t.Fatalf("verdict = %s", v)
	}
}
