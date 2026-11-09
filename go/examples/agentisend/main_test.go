package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	agentisend "github.com/fortuneflick/agentisend-go"
)

func TestAgentiSendSDKExample(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/emails" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"as-1"}`))
	}))
	defer srv.Close()
	client, err := agentisend.New("as_test", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	g := emailguard.New(emailguard.Config{Approval: emailguard.Approval{NewRecipients: true}})
	send := guardedSend(g, client)
	ctx := context.Background()
	e := Email{From: "a@example.com", To: "new@example.com", Subject: "Welcome", Text: "Ready."}

	_, err = send(ctx, e)
	var held *emailguard.ApprovalRequiredError
	if !errors.As(err, &held) || held.Decision.Evidence["rule"] != "new_recipient" {
		t.Fatalf("first send to a new address: %v", err)
	}
	sent, err := send(emailguard.Approved(ctx), e)
	if err != nil || sent["id"] != "as-1" {
		t.Fatalf("approved: %v %v", sent, err)
	}
	e.Subject, e.Text = "Next steps", "Here is what to do next."
	if _, err := send(ctx, e); err != nil {
		t.Fatalf("known recipient: %v", err)
	}
	if hits.Load() != 2 {
		t.Fatalf("API got %d calls, want 2", hits.Load())
	}
}
