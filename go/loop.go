package emailguard

import (
	"math"
	"time"
)

// Loop detection runs two independent signals over a key's recent accepted
// sends:
//
//  1. Repetition: near-identical sends (same To line, subject AND body
//     trigram similarity at or above the threshold) inside the window.
//     Catches the retry loop that sends one message 4,000 times.
//  2. Recipient entropy: a looping agent's recipients collapse onto one or
//     two inboxes even when it rewrites the content each time. Collapse only
//     holds a send addressed to one of those dominant inboxes, so a key that
//     pages its owner 30 times an hour still sends a sign-in code to a new
//     user.

// LoopMode selects which loop signals run.
type LoopMode string

const (
	// LoopFull runs both signals. An empty Mode means LoopFull.
	LoopFull LoopMode = "full"
	// LoopRepetitionOnly ignores recipient collapse.
	LoopRepetitionOnly LoopMode = "repetition_only"
	// LoopOff holds nothing.
	LoopOff LoopMode = "off"
)

// Loop configures loop detection. Zero fields take the value in LoopDefaults.
type Loop struct {
	Mode LoopMode
	// Window is the rolling window.
	Window time.Duration
	// SimilarityThreshold: subject and body similarity both at or above this
	// count as near-identical.
	SimilarityThreshold float64
	// MaxIdenticalSends: refuse when this many near-identical sends are
	// already in the window.
	MaxIdenticalSends int
	// MinWindowForEntropy: entropy is trusted only on a window this large.
	MinWindowForEntropy int
	// RecipientPerplexityFloor: collapse when the effective number of
	// recipients (2^entropy bits) is below this.
	RecipientPerplexityFloor float64
}

// LoopDefaults are the thresholds used for any field Config.Loop leaves zero.
var LoopDefaults = Loop{
	Mode:                     LoopFull,
	Window:                   60 * time.Minute,
	SimilarityThreshold:      0.85,
	MaxIdenticalSends:        3,
	MinWindowForEntropy:      20,
	RecipientPerplexityFloor: 3,
}

func (l Loop) resolved() Loop {
	if l.Mode == "" {
		l.Mode = LoopDefaults.Mode
	}
	if l.Window <= 0 {
		l.Window = LoopDefaults.Window
	}
	if l.SimilarityThreshold <= 0 {
		l.SimilarityThreshold = LoopDefaults.SimilarityThreshold
	}
	if l.MaxIdenticalSends <= 0 {
		l.MaxIdenticalSends = LoopDefaults.MaxIdenticalSends
	}
	if l.MinWindowForEntropy <= 0 {
		l.MinWindowForEntropy = LoopDefaults.MinWindowForEntropy
	}
	if l.RecipientPerplexityFloor <= 0 {
		l.RecipientPerplexityFloor = LoopDefaults.RecipientPerplexityFloor
	}
	return l
}

// RepetitionSignal is the repetition half of a loop reading.
type RepetitionSignal struct {
	Flagged               bool
	MatchingSendsInWindow int
	Threshold             int
	ClosestSubject        float64
	ClosestBody           float64
}

// EntropySignal is the recipient-entropy half of a loop reading.
type EntropySignal struct {
	// Flagged: the window collapsed AND the candidate goes to a dominant inbox.
	Flagged bool
	// WindowCollapsed: diversity is under the floor, whoever the candidate is.
	WindowCollapsed bool
	// CandidateRecipientShare is the largest share of the window's recipient
	// slots held by any address the candidate goes to.
	CandidateRecipientShare float64
	DominantShareFloor      float64
	WindowSize              int
	DistinctRecipients      int
	EntropyBits             float64
	EffectiveRecipients     float64
	TrustedSample           bool
}

// LoopVerdict names which signal fired.
type LoopVerdict string

const (
	VerdictClean           LoopVerdict = "clean"
	VerdictRepetitionLoop  LoopVerdict = "repetition_loop"
	VerdictEntropyCollapse LoopVerdict = "entropy_collapse"
	VerdictBothSignals     LoopVerdict = "both_signals"
)

// LoopResult is one loop reading.
type LoopResult struct {
	Verdict LoopVerdict
	// Decision is the refusal, or nil when the verdict is clean.
	Decision *Decision
	// Stats are the window statistics, reported on an allow too.
	Stats      Evidence
	Repetition RepetitionSignal
	Entropy    EntropySignal
}

// RecipientEntropy is the Shannon entropy, in bits, of how the window's
// recipient slots spread across addresses, plus the number of addresses.
// Each address on a send counts once.
func RecipientEntropy(window []SendRecord) (entropyBits float64, distinctRecipients int) {
	keys, counts, slots := recipientCounts(window)
	return entropyOf(keys, counts, slots), len(keys)
}

// recipientCounts keeps first-seen order so the entropy sum adds in the same
// order in every port and every run.
func recipientCounts(window []SendRecord) ([]string, map[string]int, int) {
	var keys []string
	counts := map[string]int{}
	slots := 0
	for _, s := range window {
		for _, r := range s.Recipients {
			if _, ok := counts[r]; !ok {
				keys = append(keys, r)
			}
			counts[r]++
			slots++
		}
	}
	return keys, counts, slots
}

func entropyOf(keys []string, counts map[string]int, slots int) float64 {
	bits := 0.0
	for _, k := range keys {
		p := float64(counts[k]) / float64(slots)
		bits -= p * math.Log2(p)
	}
	return bits
}

// DetectLoop evaluates a candidate against a key's recent sends as of now
// (epoch ms). Records older than the window are ignored.
func DetectLoop(recent []SendRecord, candidate SendRecord, now int64, cfg Loop) LoopResult {
	cfg = cfg.resolved()
	windowMs := cfg.Window.Milliseconds()
	window := make([]SendRecord, 0, len(recent))
	for _, s := range recent {
		if now-s.At <= windowMs {
			window = append(window, s)
		}
	}

	// Signal 1: repetition.
	matches := 0
	closestSubject, closestBody, closestSum := 0.0, 0.0, -1.0
	var candSubject, candBody map[string]struct{}
	for _, prior := range window {
		if prior.ToLine != candidate.ToLine {
			continue
		}
		s := 1.0
		if prior.Subject != candidate.Subject {
			if candSubject == nil {
				candSubject = trigrams(candidate.Subject)
			}
			s = jaccard(trigrams(prior.Subject), candSubject)
		}
		if s < cfg.SimilarityThreshold {
			continue
		}
		b := 1.0
		if prior.Body != candidate.Body {
			if candBody == nil {
				candBody = trigrams(candidate.Body)
			}
			b = jaccard(trigrams(prior.Body), candBody)
		}
		if b < cfg.SimilarityThreshold {
			continue
		}
		matches++
		if s+b > closestSum {
			closestSum, closestSubject, closestBody = s+b, s, b
		}
	}
	rep := RepetitionSignal{
		Flagged:               cfg.Mode != LoopOff && matches >= cfg.MaxIdenticalSends,
		MatchingSendsInWindow: matches,
		Threshold:             cfg.MaxIdenticalSends,
		ClosestSubject:        closestSubject,
		ClosestBody:           closestBody,
	}

	// Signal 2: recipient entropy.
	keys, counts, slots := recipientCounts(window)
	bits := entropyOf(keys, counts, slots)
	perplexity := math.Pow(2, bits)
	trusted := len(window) >= cfg.MinWindowForEntropy
	collapsed := trusted && perplexity < cfg.RecipientPerplexityFloor
	dominantFloor := 1 / cfg.RecipientPerplexityFloor
	share := 0.0
	if slots > 0 {
		for _, r := range candidate.Recipients {
			share = math.Max(share, float64(counts[r])/float64(slots))
		}
	}
	ent := EntropySignal{
		Flagged:                 cfg.Mode == LoopFull && collapsed && share >= dominantFloor,
		WindowCollapsed:         collapsed,
		CandidateRecipientShare: share,
		DominantShareFloor:      dominantFloor,
		WindowSize:              len(window),
		DistinctRecipients:      len(keys),
		EntropyBits:             bits,
		EffectiveRecipients:     perplexity,
		TrustedSample:           trusted,
	}

	stats := Evidence{
		"window_size":          len(window),
		"distinct_recipients":  len(keys),
		"entropy_bits":         round3(bits),
		"effective_recipients": round3(perplexity),
	}
	res := LoopResult{Verdict: VerdictClean, Stats: stats, Repetition: rep, Entropy: ent}
	if !rep.Flagged && !ent.Flagged {
		return res
	}

	switch {
	case rep.Flagged && ent.Flagged:
		res.Verdict = VerdictBothSignals
	case rep.Flagged:
		res.Verdict = VerdictRepetitionLoop
	default:
		res.Verdict = VerdictEntropyCollapse
	}
	var cs, cb any
	if matches > 0 {
		cs, cb = round3(closestSubject), round3(closestBody)
	}
	ev := Evidence{
		"signal_repetition":          rep.Flagged,
		"signal_entropy":             ent.Flagged,
		"matching_sends_in_window":   matches,
		"repetition_threshold":       cfg.MaxIdenticalSends,
		"closest_subject_similarity": cs,
		"closest_body_similarity":    cb,
		"perplexity_floor":           cfg.RecipientPerplexityFloor,
		"candidate_recipient_share":  round3(share),
		"dominant_share_floor":       round3(dominantFloor),
		"window_ms":                  windowMs,
	}
	for k, v := range stats {
		ev[k] = v
	}
	minutes := math.Floor(float64(windowMs)/60000 + 0.5)
	effective := round3(perplexity)
	var msg string
	switch res.Verdict {
	case VerdictRepetitionLoop:
		msg = msgLoopRepetition(matches, candidate.ToLine, minutes)
	case VerdictEntropyCollapse:
		msg = msgEntropyCollapse(len(window), effective)
	default:
		msg = msgLoopBoth(matches, candidate.ToLine, effective)
	}
	reason := ReasonRecipientEntropyCollapse
	if rep.Flagged {
		reason = ReasonLoopRepetitionDetected
	}
	d := newDecision(Refuse, reason, msg, ev)
	res.Decision = &d
	return res
}
