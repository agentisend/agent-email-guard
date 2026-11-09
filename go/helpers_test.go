package emailguard

import (
	"strings"
	"time"
)

// NOW mirrors the TypeScript tests' epoch-ms constant.
const NOW int64 = 1_800_000_000_000

func repeat(s string, n int) string { return strings.Repeat(s, n) }

// rec builds a SendRecord the way Record would: to is the To field,
// extra are further recipients (Cc).
func rec(to string, extra []string, subject, body string, at int64) SendRecord {
	return ToRecord(Send{To: []string{to}, Cc: extra, Subject: subject, Text: body}, at)
}

func cand(to, subject, body string) SendRecord { return rec(to, nil, subject, body, NOW) }

// msClock is a settable epoch-ms clock.
type msClock struct{ ms int64 }

func (c *msClock) now() time.Time { return time.UnixMilli(c.ms) }

func reason(r LoopResult) Reason {
	if r.Decision == nil {
		return ReasonOK
	}
	return r.Decision.Reason
}
