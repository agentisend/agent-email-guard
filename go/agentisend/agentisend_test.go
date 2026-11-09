package agentisend

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

type call struct{ method, path, idem, auth, body string }

func stub(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) (*Client, *[]call) {
	t.Helper()
	var calls []call
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls = append(calls, call{r.Method, r.URL.RequestURI(), r.Header.Get("idempotency-key"), r.Header.Get("authorization"), string(b)})
		handle(w, r)
	}))
	t.Cleanup(srv.Close)
	c := New("as_test_key")
	c.BaseURL = srv.URL
	return c, &calls
}

func apiErr(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", "req_1")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": body})
}

func TestSendPostsEmailsWithIdempotencyKey(t *testing.T) {
	c, calls := stub(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"id":"em_1"}`)) })
	s, err := c.Send(context.Background(), Email{From: "a@acme.com", To: []string{"b@example.com"}, Subject: "Hi", Text: "Hello."}, "idem-1")
	if err != nil || s.ID != "em_1" {
		t.Fatalf("sent=%v err=%v", s, err)
	}
	got := (*calls)[0]
	if got.method != "POST" || got.path != "/emails" || got.idem != "idem-1" || got.auth != "Bearer as_test_key" {
		t.Fatalf("call = %+v", got)
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(got.body), &body)
	if body["subject"] != "Hi" || body["text"] != "Hello." {
		t.Fatalf("body = %s", got.body)
	}
}

func TestServerRefusalsComeBackAsGuardErrors(t *testing.T) {
	cases := []struct {
		status int
		code   string
		reason emailguard.Reason
		held   bool
	}{
		{402, "agent_budget_exceeded", emailguard.ReasonAgentBudgetExceeded, false},
		{429, "rate_ceiling_exceeded", emailguard.ReasonRateCeilingExceeded, false},
		{403, "kill_switch_active", emailguard.ReasonKillSwitchActive, false},
		{422, "suppressed_recipient", emailguard.ReasonRecipientSuppressed, false},
		{403, "approval_required", emailguard.ReasonRecipientRequiresApproval, true},
	}
	for _, tc := range cases {
		c, _ := stub(t, func(w http.ResponseWriter, r *http.Request) {
			apiErr(w, tc.status, map[string]any{"code": tc.code, "message": "Refused by the API.", "fix": "Do the thing.", "action_id": "act_9", "retry_after_seconds": 30})
		})
		_, err := c.Send(context.Background(), Email{To: []string{"x@example.com"}}, "")
		var refused *emailguard.RefusedError
		var held *emailguard.ApprovalRequiredError
		var d emailguard.Decision
		switch {
		case errors.As(err, &held) && tc.held:
			d = held.Decision
		case errors.As(err, &refused) && !tc.held:
			d = refused.Decision
		default:
			t.Fatalf("%s: err = %T %v", tc.code, err, err)
		}
		if d.Reason != tc.reason || d.Message != "Refused by the API." || d.Evidence["action_id"] != "act_9" || d.Evidence["code"] != tc.code || d.Evidence["fix"] != "Do the thing." || d.Evidence["retry_after_seconds"] != 30 || !d.IsValid() {
			t.Fatalf("%s: decision = %+v", tc.code, d)
		}
	}
}

func TestOtherErrorsAreAPIErrors(t *testing.T) {
	c, _ := stub(t, func(w http.ResponseWriter, r *http.Request) {
		apiErr(w, 422, map[string]any{"code": "domain_not_verified", "message": "The from domain is not verified.", "fix": "Verify it."})
	})
	_, err := c.Send(context.Background(), Email{}, "")
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != "domain_not_verified" || ae.Status != 422 || ae.RequestID != "req_1" {
		t.Fatalf("err = %v", err)
	}
}

func TestLimitsKillAndActionsHitTheRealPaths(t *testing.T) {
	view := `{"api_key_id":"k1","budget_per_period":100,"period":"daily","consumed_in_period":3,"rate_ceiling_per_minute":10,"consumed_in_window":1,"paused":false,"paused_at":null,"paused_reason":null}`
	c, calls := stub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent-actions" {
			_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"act_1","kind":"send_email","state":"pending","payload":{},"created_at":"2026-11-09T00:00:00Z"}],"has_more":false,"next_cursor":null}`))
			return
		}
		_, _ = w.Write([]byte(view))
	})
	ctx := context.Background()
	v, err := c.GetLimits(ctx, "k1")
	if err != nil || *v.BudgetPerPeriod != 100 || v.Period != "daily" {
		t.Fatalf("view=%+v err=%v", v, err)
	}
	if _, err := c.SetLimits(ctx, "k1", Limits{BudgetPerPeriod: emailguard.Limit(50), Period: "daily"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetLimits(ctx, "k1", Limits{}); err == nil {
		t.Fatal("empty patch should be rejected locally")
	}
	if _, err := c.Kill(ctx, "k1", "looping"); err != nil {
		t.Fatal(err)
	}
	acts, err := c.Actions(ctx, "pending")
	if err != nil || len(acts) != 1 || acts[0].ID != "act_1" {
		t.Fatalf("actions=%v err=%v", acts, err)
	}
	want := []call{
		{method: "GET", path: "/limits/keys/k1"},
		{method: "PATCH", path: "/limits/keys/k1", body: `{"budget_per_period":50,"period":"daily"}`},
		{method: "POST", path: "/limits/keys/k1/kill", body: `{"reason":"looping"}`},
		{method: "GET", path: "/agent-actions?state=pending"},
	}
	for i, w := range want {
		g := (*calls)[i]
		if g.method != w.method || g.path != w.path || (w.body != "" && g.body != w.body) {
			t.Fatalf("call %d = %+v, want %+v", i, g, w)
		}
	}
}

func TestGuardSendMapsTheEmail(t *testing.T) {
	s := GuardSend("bot", Email{To: []string{"a@x.com"}, Subject: "s", HTML: "<p>h</p>"})
	if s.Key != "bot" || s.To[0] != "a@x.com" || s.HTML != "<p>h</p>" {
		t.Fatalf("send = %+v", s)
	}
}

func TestCheckUsesPreflightAndSendsNothing(t *testing.T) {
	answers := []string{
		`{"ok":true,"simulated":false,"error":null}`,
		`{"ok":false,"error":{"code":"approval_required","message":"Held for a person","fix":"Approve it in the console."}}`,
		`{"ok":false,"error":{"code":"domain_not_verified","message":"Not verified.","fix":"Verify it."}}`,
	}
	i := 0
	c, calls := stub(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(answers[i])); i++ })
	ctx := context.Background()
	d, err := c.Check(ctx, Email{To: []string{"a@example.com"}})
	if err != nil || !d.Allowed() || d.Message != "Every send gate on the API passed; nothing was sent." || d.Evidence["simulated"] != false {
		t.Fatalf("allow = %+v %v", d, err)
	}
	d, err = c.Check(ctx, Email{To: []string{"a@example.com"}})
	if err != nil || d.Outcome != emailguard.HoldForApproval || d.Message != "Held for a person." || d.Evidence["fix"] != "Approve it in the console." {
		t.Fatalf("hold = %+v %v", d, err)
	}
	var ae *APIError
	if _, err := c.Check(ctx, Email{}); !errors.As(err, &ae) || ae.Code != "domain_not_verified" {
		t.Fatalf("other = %v", err)
	}
	if (*calls)[0].path != "/emails/preflight" || (*calls)[0].method != "POST" {
		t.Fatalf("call = %+v", (*calls)[0])
	}
}

func TestResumeAndApproveBelongToAPerson(t *testing.T) {
	c := New("k")
	if err := c.Resume(context.Background(), "k1"); !errors.Is(err, ErrResumeInConsole) {
		t.Fatalf("resume = %v", err)
	}
	c2, _ := stub(t, func(w http.ResponseWriter, r *http.Request) {
		apiErr(w, 403, map[string]any{"code": "approval_required", "message": "Held.", "action_id": "act_1"})
	})
	_, err := c2.Send(context.Background(), Email{}, "")
	var held *emailguard.ApprovalRequiredError
	if !errors.As(err, &held) || held.Decision.Evidence["fix"] != nil {
		t.Fatalf("err = %v", err)
	}
	if _, err := held.Approve(context.Background()); !errors.Is(err, ErrApproveInConsole) {
		t.Fatalf("approve = %v", err)
	}
}
