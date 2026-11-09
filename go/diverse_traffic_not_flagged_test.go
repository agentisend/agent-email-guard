package emailguard

import (
	"fmt"
	"math"
	"testing"
)

// lcg reproduces the TypeScript test's generator exactly.
func lcg(seed uint32) func() float64 {
	state := uint64(seed)
	return func() float64 {
		state = (state*1664525 + 1013904223) & 0xffffffff
		return float64(state) / 0xffffffff
	}
}

var (
	firstNames = []string{"ana", "belle", "carlos", "dee", "elena", "farid", "gita", "hugo", "ines", "jonas"}
	lastNames  = []string{"acme", "bright", "cedarline", "deltaworks", "everly", "foxglove", "granitetech"}
	topics     = []string{"invoice", "receipt", "welcome", "password reset", "weekly digest", "shipping notice"}
)

func pick(r func() float64, list []string) string {
	return list[int(math.Floor(r()*float64(len(list))))]
}

func legitimateTraffic(count int, seed uint32) []SendRecord {
	r := lcg(seed)
	out := make([]SendRecord, count)
	for i := range out {
		to := pick(r, firstNames) + "@" + pick(r, lastNames) + ".com"
		subject := fmt.Sprintf("Your %s (#%d)", pick(r, topics), int(math.Floor(r()*100000)))
		body := fmt.Sprintf("Hello %s, here are the details you asked for regarding %s. Reference %d.", pick(r, firstNames), pick(r, topics), int64(math.Floor(r()*1e9)))
		out[i] = rec(to, nil, subject, body, NOW-(int64(count-i)*30_000))
	}
	return out
}

func TestDiverse_Clears120VariedSends(t *testing.T) {
	c := cand("newcustomer@brightco.io", "Your invoice (#88213)", "Hello ana, here are the details you asked for regarding invoice. Reference 554032987.")
	r := DetectLoop(legitimateTraffic(120, 42), c, NOW, Loop{})
	if r.Verdict != VerdictClean || r.Decision != nil {
		t.Fatalf("result = %+v", r.Decision)
	}
	// 10 first names x 7 domains = 70 possible recipients.
	if r.Entropy.DistinctRecipients <= 40 || r.Entropy.EffectiveRecipients <= 10 || r.Repetition.MatchingSendsInWindow != 0 {
		t.Fatalf("entropy = %+v repetition = %+v", r.Entropy, r.Repetition)
	}
}

func TestDiverse_SmallAgentBelowSampleFloorIsClear(t *testing.T) {
	r := DetectLoop(legitimateTraffic(12, 7), cand("one@of-the-three.com", "s", "b"), NOW, Loop{})
	if r.Entropy.TrustedSample || r.Entropy.Flagged || r.Verdict != VerdictClean {
		t.Fatalf("entropy = %+v verdict = %s", r.Entropy, r.Verdict)
	}
}

func TestDiverse_RepeatCorrespondenceWithDifferentContent(t *testing.T) {
	var window []SendRecord
	for round := 0; round < 6; round++ {
		for c := 0; c < 25; c++ {
			window = append(window, rec(fmt.Sprintf("customer%d@theirco.com", c), nil, fmt.Sprintf("Re: ticket %d update %d", c, round), fmt.Sprintf("Round %d for ticket %d: we reproduced the issue on build %d%d and shipped a fix candidate.", round, c, round, c), NOW-(int64(150-len(window))*20_000)))
		}
	}
	r := DetectLoop(window, cand("customer7@theirco.com", "Re: ticket 7 update 6", "Round 6 for ticket 7: fix verified in staging."), NOW, Loop{})
	if r.Repetition.Flagged || r.Entropy.Flagged || r.Verdict != VerdictClean {
		t.Fatalf("verdict = %s", r.Verdict)
	}
}
