package emailguard

import (
	"context"
	"errors"
	"testing"
)

func TestWrap_RecordsSoTheFourthIdenticalSendIsRefused(t *testing.T) {
	g := New(Config{})
	calls := 0
	send := g.Wrap(func(ctx context.Context, s Send) error { calls++; return nil })
	s := Send{Key: "bot", To: []string{"user@example.com"}, Subject: "Your receipt", Text: "Thanks for your order #1."}
	for i := 0; i < 3; i++ {
		if err := send(context.Background(), s); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	err := send(context.Background(), s)
	var refused *RefusedError
	if !errors.As(err, &refused) || refused.Decision.Reason != ReasonLoopRepetitionDetected {
		t.Fatalf("err = %v", err)
	}
	if calls != 3 {
		t.Fatalf("provider called %d times", calls)
	}
}

func TestWrap_ProviderFailureReleasesTheBudget(t *testing.T) {
	g := New(Config{Budgets: Budgets{PerDay: Limit(1)}, Loop: Loop{Mode: LoopOff}})
	boom := errors.New("provider down")
	fail := true
	send := g.Wrap(func(ctx context.Context, s Send) error {
		if fail {
			return boom
		}
		return nil
	})
	s := Send{To: []string{"user@example.com"}}
	if err := send(context.Background(), s); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	fail = false
	if err := send(context.Background(), s); err != nil {
		t.Fatalf("budget was not released: %v", err)
	}
	var refused *RefusedError
	if err := send(context.Background(), s); !errors.As(err, &refused) {
		t.Fatalf("third send should exceed the budget: %v", err)
	}
}

func TestWrap_HoldsNewRecipientsUntilApproved(t *testing.T) {
	g := New(Config{Approval: Approval{NewRecipients: true}})
	ctx := context.Background()
	send := g.Wrap(func(ctx context.Context, s Send) error { return nil })
	s := Send{To: []string{"New <New@Example.com>"}, Cc: []string{"cc@example.com"}}
	err := send(ctx, s)
	var held *ApprovalRequiredError
	if !errors.As(err, &held) || held.Decision.Evidence["new_recipients"] != "new@example.com,cc@example.com" {
		t.Fatalf("err = %v", err)
	}
	if err := send(Approved(ctx), s); err != nil {
		t.Fatalf("approved: %v", err)
	}
	if err := send(ctx, s); err != nil {
		t.Fatalf("known recipients should pass: %v", err)
	}
}

func TestWrapFunc_KeepsTheProviderSignature(t *testing.T) {
	type req struct{ To, Subject string }
	type resp struct{ ID string }
	g := New(Config{Suppress: []string{"@blocked.example"}})
	send := WrapFunc(g, func(r req) Send { return Send{To: []string{r.To}, Subject: r.Subject} },
		func(ctx context.Context, r req) (resp, error) { return resp{ID: "msg_1"}, nil })
	out, err := send(context.Background(), req{To: "a@ok.example", Subject: "hi"})
	if err != nil || out.ID != "msg_1" {
		t.Fatalf("out=%v err=%v", out, err)
	}
	var refused *RefusedError
	if _, err := send(context.Background(), req{To: "x@blocked.example"}); !errors.As(err, &refused) {
		t.Fatalf("suppressed address: %v", err)
	}
}

func TestToRecord_NormalizesAddressesAndText(t *testing.T) {
	r := ToRecord(Send{To: []string{"B <B@x.com>, a@x.com"}, Cc: []string{"a@x.com", "c@x.com"}, Bcc: []string{"d@x.com"}, Subject: "Héllo, World!", HTML: "<p>Hi</p>"}, 7)
	if r.ToLine != "a@x.com,b@x.com" || len(r.Recipients) != 4 || r.Recipients[0] != "b@x.com" || r.Subject != "h llo world" || r.Body != "p hi p" || r.At != 7 {
		t.Fatalf("record = %+v", r)
	}
}

func TestWrap_ApproveReRunsTheCallAsApproved(t *testing.T) {
	g := New(Config{Approval: Approval{Recipients: []string{"@bigco.com"}}})
	calls := 0
	send := WrapFunc(g, func(to string) Send { return Send{To: []string{to}} },
		func(ctx context.Context, to string) (string, error) { calls++; return "sent:" + to, nil })
	_, err := send(context.Background(), "ceo@bigco.com")
	var held *ApprovalRequiredError
	if !errors.As(err, &held) || held.Approve == nil {
		t.Fatalf("err = %v", err)
	}
	out, err := held.Approve(context.Background())
	if err != nil || out != "sent:ceo@bigco.com" || calls != 1 {
		t.Fatalf("approve = %v %v calls=%d", out, err, calls)
	}
}
