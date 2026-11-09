package emailguard

import (
	"strings"
	"testing"
)

const roadmapSubject = "Quick question about your roadmap"
const roadmapBody = "Hi — I wanted to follow up on my last note about your Q3 roadmap. Any interest?"

func identicalSends(count int) []SendRecord {
	out := make([]SendRecord, count)
	for i := range out {
		out[i] = rec("victim@example.com", nil, roadmapSubject, roadmapBody, NOW-(int64(count-i)*10))
	}
	return out
}

var roadmapCandidate = cand("victim@example.com", roadmapSubject, roadmapBody)

func TestLoop4000_CatchesThe4001stNearIdenticalSend(t *testing.T) {
	r := DetectLoop(identicalSends(4000), roadmapCandidate, NOW, Loop{})
	if r.Verdict != VerdictRepetitionLoop && r.Verdict != VerdictBothSignals {
		t.Fatalf("verdict = %s", r.Verdict)
	}
	if r.Decision.Outcome != Refuse || reason(r) != ReasonLoopRepetitionDetected {
		t.Fatalf("decision = %+v", r.Decision)
	}
}

func TestLoop4000_CarriesEvidence(t *testing.T) {
	c := cand("victim@example.com", roadmapSubject, "Hi — I wanted to follow up on my last note about my Q3 roadmap. Any interest?")
	ev := DetectLoop(identicalSends(4000), c, NOW, Loop{}).Decision.Evidence
	if ev["matching_sends_in_window"] != 4000 || ev["repetition_threshold"] != 3 || ev["window_ms"] != int64(3600000) {
		t.Fatalf("evidence = %v", ev)
	}
	if ev["closest_subject_similarity"].(float64) <= 0.99 || ev["closest_body_similarity"].(float64) < 0.85 {
		t.Fatalf("similarities = %v / %v", ev["closest_subject_similarity"], ev["closest_body_similarity"])
	}
}

func TestLoop4000_ExplainsInASentence(t *testing.T) {
	r := DetectLoop(identicalSends(4000), roadmapCandidate, NOW, Loop{})
	if !r.Repetition.Flagged || !strings.Contains(r.Decision.Message, "near-identical emails") || !strings.HasSuffix(strings.TrimSpace(r.Decision.Message), ".") {
		t.Fatalf("message = %q", r.Decision.Message)
	}
}

func TestLoop4000_FlagsAtThresholdNotBefore(t *testing.T) {
	if v := DetectLoop(identicalSends(2), roadmapCandidate, NOW, Loop{}).Verdict; v != VerdictClean {
		t.Fatalf("2 sends: %s", v)
	}
	if v := DetectLoop(identicalSends(3), roadmapCandidate, NOW, Loop{}).Verdict; v != VerdictRepetitionLoop {
		t.Fatalf("3 sends: %s", v)
	}
}

func TestLoop4000_IgnoresSendsOutsideTheWindow(t *testing.T) {
	stale := identicalSends(50)
	for i := range stale {
		stale[i].At = NOW - 2*60*60*1000
	}
	if v := DetectLoop(stale, roadmapCandidate, NOW, Loop{}).Verdict; v != VerdictClean {
		t.Fatalf("verdict = %s", v)
	}
}
