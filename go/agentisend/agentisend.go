// Package agentisend sends through AgentiSend, where the same rules the guard
// library applies in your process are enforced at the API: a key's budget,
// per-minute ceiling, loop holds, approval queue and kill switch. Code that
// skips the library still cannot send past them, because the key itself is
// limited.
//
// A refusal or hold comes back as the same *emailguard.RefusedError or
// *emailguard.ApprovalRequiredError the library returns, so one error path covers
// both. The adapter uses net/http only.
package agentisend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

// DefaultBaseURL is the AgentiSend API.
const DefaultBaseURL = "https://api.agentisend.com"

// Client calls the AgentiSend API with one API key.
type Client struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
}

// New returns a Client. An empty apiKey reads AGENTISEND_API_KEY; the base
// URL reads AGENTISEND_BASE_URL, then DefaultBaseURL.
func New(apiKey string) *Client {
	if apiKey == "" {
		apiKey = os.Getenv("AGENTISEND_API_KEY")
	}
	base := os.Getenv("AGENTISEND_BASE_URL")
	if base == "" {
		base = DefaultBaseURL
	}
	return &Client{APIKey: apiKey, BaseURL: strings.TrimRight(base, "/"), HTTP: http.DefaultClient}
}

// APIError is an AgentiSend error the guard has no token for (a bad
// request, an unverified domain, a server error).
type APIError struct {
	Status            int
	Code              string
	Message           string
	Fix               string
	RequestID         string
	RetryAfterSeconds int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("agentisend [%s]: %s %s", e.Code, e.Message, e.Fix)
}

type envelope struct {
	Error struct {
		Code              string `json:"code"`
		Message           string `json:"message"`
		Fix               string `json:"fix"`
		ActionID          string `json:"action_id"`
		RetryAfterSeconds *int   `json:"retry_after_seconds"`
	} `json:"error"`
}

// API error codes the guard has a reason token for.
var codeToReason = map[string]struct {
	reason  emailguard.Reason
	outcome emailguard.Outcome
}{
	"agent_budget_exceeded": {emailguard.ReasonAgentBudgetExceeded, emailguard.Refuse},
	"rate_ceiling_exceeded": {emailguard.ReasonRateCeilingExceeded, emailguard.Refuse},
	"kill_switch_active":    {emailguard.ReasonKillSwitchActive, emailguard.Refuse},
	"suppressed_recipient":  {emailguard.ReasonRecipientSuppressed, emailguard.Refuse},
	"approval_required":     {emailguard.ReasonRecipientRequiresApproval, emailguard.HoldForApproval},
}

func (c *Client) do(ctx context.Context, method, path string, body any, idempotencyKey string, out any) error {
	var r io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		r = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, r)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+c.APIKey)
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", "agent-email-guard-go/"+Version)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if idempotencyKey != "" {
		req.Header.Set("idempotency-key", idempotencyKey)
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		return decodeError(res, raw)
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// ErrApproveInConsole is what ApprovalRequiredError.Approve returns for a
// send AgentiSend holds: a person approves it in the console, and approving
// it sends it.
var ErrApproveInConsole = errors.New("a held AgentiSend send is approved by a person in the console (Agents, Approvals); approving it sends it")

// ErrResumeInConsole is what Resume returns: an API key cannot resume itself.
var ErrResumeInConsole = errors.New("an API key cannot resume itself; a person signed in to the AgentiSend console resumes it under Agents")

func approveInConsole(context.Context) (any, error) { return nil, ErrApproveInConsole }

// decisionFrom maps an API error onto a guard decision. Message and evidence
// come from the API, not from the library's templates.
func decisionFrom(code, message, fix, actionID string, retryAfter *int) (emailguard.Decision, bool) {
	m, ok := codeToReason[code]
	if !ok {
		return emailguard.Decision{}, false
	}
	ev := emailguard.Evidence{"code": code, "fix": nil}
	if fix != "" {
		ev["fix"] = fix
	}
	if actionID != "" {
		ev["action_id"] = actionID
	}
	if retryAfter != nil {
		ev["retry_after_seconds"] = *retryAfter
	}
	msg := strings.TrimSpace(message)
	if !strings.HasSuffix(msg, ".") {
		msg += "."
	}
	return emailguard.Decision{Outcome: m.outcome, Reason: m.reason, Message: msg, Evidence: ev}, true
}

func decodeError(res *http.Response, raw []byte) error {
	var env envelope
	_ = json.Unmarshal(raw, &env)
	e := env.Error
	retry := 0
	if e.RetryAfterSeconds != nil {
		retry = *e.RetryAfterSeconds
	} else if h := res.Header.Get("retry-after"); h != "" {
		retry, _ = strconv.Atoi(h)
	}
	if d, ok := decisionFrom(e.Code, e.Message, e.Fix, e.ActionID, e.RetryAfterSeconds); ok {
		if d.Outcome == emailguard.HoldForApproval {
			return &emailguard.ApprovalRequiredError{Decision: d, Approve: approveInConsole}
		}
		return &emailguard.RefusedError{Decision: d}
	}
	code := e.Code
	if code == "" {
		code = "unexpected_error"
	}
	return &APIError{Status: res.StatusCode, Code: code, Message: e.Message, Fix: e.Fix, RequestID: res.Header.Get("x-request-id"), RetryAfterSeconds: retry}
}

// Email is one message for POST /emails.
type Email struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	Cc      []string          `json:"cc,omitempty"`
	Bcc     []string          `json:"bcc,omitempty"`
	ReplyTo []string          `json:"reply_to,omitempty"`
	Subject string            `json:"subject"`
	Text    string            `json:"text,omitempty"`
	HTML    string            `json:"html,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Tags    []Tag             `json:"tags,omitempty"`
}

// Tag is a name/value label on an email.
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Sent is the API's answer to an accepted email.
type Sent struct {
	ID string `json:"id"`
}

// Send posts one email. Pass an idempotencyKey on anything you might retry,
// so a repeat is applied once. A budget, ceiling, kill switch or suppression
// refusal returns *emailguard.RefusedError; a loop or approval hold returns
// *emailguard.ApprovalRequiredError with the held send's action_id in its evidence.
func (c *Client) Send(ctx context.Context, email Email, idempotencyKey string) (Sent, error) {
	var s Sent
	err := c.do(ctx, http.MethodPost, "/emails", email, idempotencyKey, &s)
	return s, err
}

// Check runs every send gate on the API (POST /emails/preflight) and sends
// nothing. A gate that would refuse or hold comes back as the decision; any
// other problem is an *APIError.
func (c *Client) Check(ctx context.Context, email Email) (emailguard.Decision, error) {
	var report struct {
		OK        bool `json:"ok"`
		Simulated bool `json:"simulated"`
		Error     *struct {
			Code              string `json:"code"`
			Message           string `json:"message"`
			Fix               string `json:"fix"`
			ActionID          string `json:"action_id"`
			RetryAfterSeconds *int   `json:"retry_after_seconds"`
		} `json:"error"`
	}
	err := c.do(ctx, http.MethodPost, "/emails/preflight", email, "", &report)
	var refused *emailguard.RefusedError
	var held *emailguard.ApprovalRequiredError
	switch {
	case errors.As(err, &refused):
		return refused.Decision, nil
	case errors.As(err, &held):
		return held.Decision, nil
	case err != nil:
		return emailguard.Decision{}, err
	}
	if report.OK {
		return emailguard.Decision{Outcome: emailguard.Allow, Reason: emailguard.ReasonOK,
			Message: "Every send gate on the API passed; nothing was sent.", Evidence: emailguard.Evidence{"simulated": report.Simulated}}, nil
	}
	if e := report.Error; e != nil {
		if d, ok := decisionFrom(e.Code, e.Message, e.Fix, e.ActionID, e.RetryAfterSeconds); ok {
			return d, nil
		}
		code := e.Code
		if code == "" {
			code = "preflight_failed"
		}
		return emailguard.Decision{}, &APIError{Status: 422, Code: code, Message: e.Message, Fix: e.Fix}
	}
	return emailguard.Decision{}, &APIError{Status: 422, Code: "preflight_failed", Message: "Preflight failed."}
}

// Resume always returns ErrResumeInConsole: POST /limits/keys/{id}/resume is
// a person's action in the console, and a paused key cannot resume itself.
func (c *Client) Resume(context.Context, string) error { return ErrResumeInConsole }

// GuardSend describes email to a local guard, for running emailguard.Check before
// AgentiSend checks it again server-side.
func GuardSend(key string, email Email) emailguard.Send {
	return emailguard.Send{Key: key, From: email.From, To: email.To, Cc: email.Cc, Bcc: email.Bcc, Subject: email.Subject, Text: email.Text, HTML: email.HTML}
}

// LimitView is a key's limits as GET /limits/keys/{id} reports them.
type LimitView struct {
	APIKeyID             string  `json:"api_key_id"`
	BudgetPerPeriod      *int    `json:"budget_per_period"`
	Period               string  `json:"period"`
	ConsumedInPeriod     int     `json:"consumed_in_period"`
	PeriodStartedAt      string  `json:"period_started_at"`
	RateCeilingPerMinute *int    `json:"rate_ceiling_per_minute"`
	ConsumedInWindow     int     `json:"consumed_in_window"`
	Paused               bool    `json:"paused"`
	PausedAt             *string `json:"paused_at"`
	PausedReason         *string `json:"paused_reason"`
}

// Limits is a change for PATCH /limits/keys/{id}. Nil fields stay as they
// are. A key may lower its own limits; raising one is a person's decision,
// made in the console.
type Limits struct {
	BudgetPerPeriod      *int   `json:"budget_per_period,omitempty"`
	Period               string `json:"period,omitempty"` // "hourly", "daily" or "monthly"
	RateCeilingPerMinute *int   `json:"rate_ceiling_per_minute,omitempty"`
}

// GetLimits reads a key's budget, ceiling, consumption and pause state.
func (c *Client) GetLimits(ctx context.Context, keyID string) (LimitView, error) {
	var v LimitView
	err := c.do(ctx, http.MethodGet, "/limits/keys/"+url.PathEscape(keyID), nil, "", &v)
	return v, err
}

// SetLimits changes a key's budget, period or per-minute ceiling.
func (c *Client) SetLimits(ctx context.Context, keyID string, l Limits) (LimitView, error) {
	if l.BudgetPerPeriod == nil && l.Period == "" && l.RateCeilingPerMinute == nil {
		return LimitView{}, errors.New("agentisend: SetLimits needs at least one of BudgetPerPeriod, Period or RateCeilingPerMinute")
	}
	var v LimitView
	err := c.do(ctx, http.MethodPatch, "/limits/keys/"+url.PathEscape(keyID), l, "", &v)
	return v, err
}

// Kill pauses a key at the API, effective on its next request. Only a person
// signed in to the console can resume it; the paused key cannot.
func (c *Client) Kill(ctx context.Context, keyID, reason string) (LimitView, error) {
	var body any
	if reason != "" {
		body = map[string]string{"reason": reason}
	}
	var v LimitView
	err := c.do(ctx, http.MethodPost, "/limits/keys/"+url.PathEscape(keyID)+"/kill", body, "", &v)
	return v, err
}

// Action is one held send in the approval queue.
type Action struct {
	ID             string         `json:"id"`
	Kind           string         `json:"kind"`
	State          string         `json:"state"`
	Payload        map[string]any `json:"payload"`
	DecidedBy      *string        `json:"decided_by"`
	DecisionReason *string        `json:"decision_reason"`
	DecidedAt      *string        `json:"decided_at"`
	CreatedAt      string         `json:"created_at"`
	ExpiresAt      *string        `json:"expires_at"`
}

// Actions lists held agent actions, newest first. state is "pending",
// "approved", "rejected", "killed" or "" for all. A person approves or
// rejects them in the console; the key that asked cannot approve itself.
func (c *Client) Actions(ctx context.Context, state string) ([]Action, error) {
	path := "/agent-actions"
	if state != "" {
		path += "?state=" + url.QueryEscape(state)
	}
	var page struct {
		Data []Action `json:"data"`
	}
	err := c.do(ctx, http.MethodGet, path, nil, "", &page)
	return page.Data, err
}
