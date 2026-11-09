package emailguard

import (
	"fmt"
	"math"
	"strconv"
	"time"
)

// Every sentence the guard can say lives in this file. Reason tokens and
// these templates are part of the cross-language contract: the Node, Python,
// PHP and Go ports render byte-identical strings, pinned by spec/vectors.

// round3 rounds half up to 3 decimals: floor(x*1000 + 0.5) / 1000.
func round3(n float64) float64 { return math.Floor(n*1000+0.5) / 1000 }

// formatNumber prints integers bare and other numbers as the shortest
// round-trip decimal, as JavaScript's String(n) does.
func formatNumber(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

// plural renders "1 email", "2 emails".
func plural(n float64, singular string) string {
	if n == 1 {
		return formatNumber(n) + " " + singular
	}
	return formatNumber(n) + " " + singular + "s"
}

// formatInstant renders epoch ms as YYYY-MM-DDTHH:MM:SSZ in UTC.
func formatInstant(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05Z")
}

var periodAdjective = map[string]string{"hour": "hourly", "day": "daily", "month": "monthly"}

const (
	msgOK         = "No limit, loop or approval rule blocks this send."
	msgKillSwitch = "Sending is paused by the kill switch, so nothing sends until a person resumes it."
	msgCustomRule = "Your approval rule matched this email, so it waits for a person to approve it."
)

func msgSuppressed(recipient, rule string) string {
	return fmt.Sprintf("%s is on the suppression list (rule: %s), so this guard never sends to it.", recipient, rule)
}

func msgLoopRepetition(matches int, toLine string, minutes float64) string {
	return fmt.Sprintf("Blocked: %s already went to %s within %s, which matches a retry or script loop; review the agent before sending more.",
		plural(float64(matches), "near-identical email"), toLine, plural(minutes, "minute"))
}

func msgLoopBoth(matches int, toLine string, effective float64) string {
	return fmt.Sprintf("Blocked: this key shows both a repetition loop (%s to %s) and collapsed recipient diversity (about %s); review the agent before sending more.",
		plural(float64(matches), "near-identical email"), toLine, plural(effective, "effective recipient"))
}

func msgEntropyCollapse(windowSize int, effective float64) string {
	return fmt.Sprintf("Blocked: the last %s went to about %s, and this one goes to the same inbox again, which looks like a loop; mail to other recipients still sends.",
		plural(float64(windowSize), "email"), plural(effective, "effective recipient"))
}

func msgApprovalRule(recipient, rule string) string {
	return fmt.Sprintf("%s matches the approval rule %s, so this email waits for a person to approve it.", recipient, rule)
}

func msgNewRecipient(recipient, key string) string {
	return fmt.Sprintf("%s has not received email from key \"%s\" before, so this email waits for a person to approve it.", recipient, key)
}

func msgRateCeiling(key string, ceiling, retryAfter int) string {
	return fmt.Sprintf("Key \"%s\" reached its ceiling of %s per minute; wait %s and try again.",
		key, plural(float64(ceiling), "send"), plural(float64(retryAfter), "second"))
}

func msgBudget(key, period string, budget int, resetsAt int64) string {
	return fmt.Sprintf("Key \"%s\" has used its %s budget of %s; it resets at %s.",
		key, periodAdjective[period], plural(float64(budget), "email"), formatInstant(resetsAt))
}
