package emailguard

import (
	"fmt"
	"math"
	"regexp"
	"testing"
)

func mutatedContentLoop(count int) []SendRecord {
	out := make([]SendRecord, count)
	for i := range out {
		to := "target2@example.com"
		if i%2 == 0 {
			to = "target@example.com"
		}
		body := fmt.Sprintf("Message %d: %s quick thought on your %s", i, repeat("x", 3+i%7), []string{"pricing", "roadmap", "team", "growth"}[i%4]) +
			fmt.Sprintf(" plans; happy to share what we learned with teams like yours this %s. Ref %d.", []string{"spring", "summer", "autumn", "winter"}[i%4], i*7919)
		out[i] = rec(to, nil, fmt.Sprintf("Following up — note %d of my sequence", i), body, NOW-(int64(count-i)*5_000))
	}
	return out
}

func TestEntropy_FlagsTwoRecipientContentMutatingLoop(t *testing.T) {
	r := DetectLoop(mutatedContentLoop(60), cand("target@example.com", "Following up — note 60 of my sequence", "Message 60: xxx quick thought on your pricing plans; totally new wording entirely unrelated to prior sends. Ref 474540."), NOW, Loop{})
	if r.Repetition.Flagged || r.Repetition.MatchingSendsInWindow != 0 {
		t.Fatalf("repetition = %+v", r.Repetition)
	}
	if !r.Entropy.Flagged || r.Verdict != VerdictEntropyCollapse || reason(r) != ReasonRecipientEntropyCollapse || r.Decision.Outcome != Refuse {
		t.Fatalf("result = %s %+v", r.Verdict, r.Decision)
	}
}

func TestEntropy_ReportsTheMath(t *testing.T) {
	w := mutatedContentLoop(60)
	bits, distinct := RecipientEntropy(w)
	if distinct != 2 || math.Abs(bits-1) > 1e-5 {
		t.Fatalf("bits=%v distinct=%d", bits, distinct)
	}
	r := DetectLoop(w, cand("target@example.com", "new", "new body text"), NOW, Loop{})
	if math.Abs(r.Entropy.EffectiveRecipients-2) > 1e-3 || math.Abs(r.Decision.Evidence["effective_recipients"].(float64)-2) > 1e-3 {
		t.Fatalf("effective = %v", r.Entropy.EffectiveRecipients)
	}
	if r.Decision.Evidence["distinct_recipients"] != 2 || !regexp.MustCompile(`(?i)diversity|recipients`).MatchString(r.Decision.Message) {
		t.Fatalf("evidence = %v message = %q", r.Decision.Evidence, r.Decision.Message)
	}
}

func TestEntropy_DiverseWindowOfSameSizeIsClean(t *testing.T) {
	diverse := make([]SendRecord, 60)
	for i := range diverse {
		diverse[i] = rec(fmt.Sprintf("lead%d@company%d.com", i, i%30), nil, fmt.Sprintf("Outreach %d", i), fmt.Sprintf("Unique message %d with plenty of distinct trigrams to keep similarity far below threshold.", i), NOW-(int64(60-i)*5_000))
	}
	r := DetectLoop(diverse, cand("lead60@company30.com", "Outreach 60", "A fresh unique message."), NOW, Loop{})
	if r.Entropy.Flagged || r.Verdict != VerdictClean {
		t.Fatalf("verdict = %s", r.Verdict)
	}
}
