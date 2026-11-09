package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
)

func TestSESv2Example(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/email/outbound-emails" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"MessageId":"ses-1"}`))
	}))
	defer srv.Close()
	client := sesv2.New(sesv2.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(srv.URL),
		Credentials:  credentials.NewStaticCredentialsProvider("AKID", "SECRET", ""),
	})
	g := emailguard.New(emailguard.Config{})
	send := guardedSend(g, client)
	ctx := context.Background()
	msg := message("customer@example.com", "Your receipt", "Order 1182 is paid.")
	for i := 0; i < 3; i++ {
		out, err := send(ctx, msg)
		if err != nil || aws.ToString(out.MessageId) != "ses-1" {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	_, err := send(ctx, msg)
	var refused *emailguard.RefusedError
	if !errors.As(err, &refused) || refused.Decision.Reason != emailguard.ReasonLoopRepetitionDetected {
		t.Fatalf("fourth identical send: %v", err)
	}
	if hits.Load() != 3 {
		t.Fatalf("SES got %d calls, want 3", hits.Load())
	}
}
