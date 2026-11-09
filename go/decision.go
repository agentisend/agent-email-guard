// Package guard decides whether an AI agent may send an email: per-key
// budgets, a per-minute rate ceiling, loop detection, a kill switch and
// approval holds. It works with any email provider.
//
// The library is advisory: it runs in the agent's own process, so code that
// skips Check skips the guard. AgentiSend enforces the same rules at its API,
// where the agent cannot route around them (see the agentisend sub-package).
package emailguard

import (
	"context"
	"fmt"
	"strings"
)

// Outcome is the machine-readable result of a check. Refuse and
// HoldForApproval both stop the send; they differ in what cures them.
type Outcome string

const (
	Allow           Outcome = "allow"
	HoldForApproval Outcome = "hold_for_approval"
	Refuse          Outcome = "refuse"
)

// Reason is a stable snake_case token. Programs switch on it; people read
// Decision.Message.
type Reason string

const (
	ReasonOK                        Reason = "ok"
	ReasonKillSwitchActive          Reason = "kill_switch_active"
	ReasonRecipientSuppressed       Reason = "recipient_suppressed"
	ReasonLoopRepetitionDetected    Reason = "loop_repetition_detected"
	ReasonRecipientEntropyCollapse  Reason = "recipient_entropy_collapse"
	ReasonRecipientRequiresApproval Reason = "recipient_requires_approval"
	ReasonRateCeilingExceeded       Reason = "rate_ceiling_exceeded"
	ReasonAgentBudgetExceeded       Reason = "agent_budget_exceeded"
)

// ReasonTokens lists every token a Decision can carry, in check order.
var ReasonTokens = []Reason{
	ReasonOK,
	ReasonKillSwitchActive,
	ReasonRecipientSuppressed,
	ReasonLoopRepetitionDetected,
	ReasonRecipientEntropyCollapse,
	ReasonRecipientRequiresApproval,
	ReasonRateCeilingExceeded,
	ReasonAgentBudgetExceeded,
}

// Evidence is the structured proof behind a decision: counts, windows,
// entropies, rules. Values are string, int, int64, float64, bool or nil.
type Evidence map[string]any

// Decision is what Check returns. Every decision, allow included, carries a
// reason token and one full sentence.
type Decision struct {
	Outcome  Outcome  `json:"outcome"`
	Reason   Reason   `json:"reason"`
	Message  string   `json:"message"`
	Evidence Evidence `json:"evidence"`

	// reservation is what an allowed Check took, so Release can hand back
	// exactly that, whatever the clock says by then.
	reservation *Reservation
}

// Allowed reports whether the send may go ahead.
func (d Decision) Allowed() bool { return d.Outcome == Allow }

// Reservation returns what an allowed Check reserved, or nil.
func (d Decision) Reservation() *Reservation { return d.reservation }

func newDecision(o Outcome, r Reason, msg string, ev Evidence) Decision {
	if ev == nil {
		ev = Evidence{}
	}
	return Decision{Outcome: o, Reason: r, Message: msg, Evidence: ev}
}

// IsValid checks the decision contract: a known token, a sentence of at least
// eight characters ending in a period, non-nil evidence, and "ok" if and only
// if the outcome is Allow.
func (d Decision) IsValid() bool {
	known := false
	for _, t := range ReasonTokens {
		if t == d.Reason {
			known = true
			break
		}
	}
	if !known {
		return false
	}
	msg := strings.TrimSpace(d.Message)
	if len(msg) < 8 || !strings.HasSuffix(msg, ".") || d.Evidence == nil {
		return false
	}
	return (d.Reason == ReasonOK) == (d.Outcome == Allow)
}

// RefusedError is returned by a wrapped send function when the guard refused
// the send. The provider was not called.
type RefusedError struct{ Decision Decision }

func (e *RefusedError) Error() string {
	return fmt.Sprintf("agent-email-guard refused the send (%s): %s", e.Decision.Reason, e.Decision.Message)
}

// ApprovalRequiredError is returned by a wrapped send function when the send
// needs a person to approve it first. The provider was not called. Once a
// person approves, call Approve, or call the wrapped function again with
// Approved(ctx).
type ApprovalRequiredError struct {
	Decision Decision
	// Approve re-runs the same call as approved by a person and returns the
	// provider's result (or *RefusedError if something else now blocks it).
	// Nil when the error did not come from Wrap or WrapFunc.
	Approve func(ctx context.Context) (any, error)
}

func (e *ApprovalRequiredError) Error() string {
	return fmt.Sprintf("agent-email-guard held the send for approval (%s): %s", e.Decision.Reason, e.Decision.Message)
}
