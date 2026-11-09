package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/resend/resend-go/v2"
)

func TestResendExample(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/emails" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"re-1"}`))
	}))
	defer srv.Close()
	client := resend.NewClient("re_test")
	client.BaseURL, _ = url.Parse(srv.URL + "/")
	g := emailguard.New(emailguard.Config{Approval: emailguard.Approval{Recipients: []string{"@bigcustomer.com"}}})
	send := guardedSend(g, client)
	ctx := context.Background()

	sent, err := send(ctx, &resend.SendEmailRequest{From: "a@example.com", To: []string{"c@example.com"}, Subject: "Hi", Text: "Hello."})
	if err != nil || sent.Id != "re-1" {
		t.Fatalf("send: %v %v", sent, err)
	}
	req := &resend.SendEmailRequest{From: "a@example.com", To: []string{"cfo@bigcustomer.com"}, Subject: "Invoice", Text: "Attached."}
	_, err = send(ctx, req)
	var held *emailguard.ApprovalRequiredError
	if !errors.As(err, &held) {
		t.Fatalf("held send: %v", err)
	}
	if _, err := send(emailguard.Approved(ctx), req); err != nil {
		t.Fatalf("approved send: %v", err)
	}
	if hits.Load() != 2 {
		t.Fatalf("Resend got %d calls, want 2", hits.Load())
	}
}
