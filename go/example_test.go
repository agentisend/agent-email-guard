package emailguard_test

import (
	"context"
	"errors"
	"fmt"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

func sendWithYourProvider(ctx context.Context, s emailguard.Send) error { return nil }

func Example() {
	g := emailguard.New(emailguard.Config{
		Budgets: emailguard.Budgets{PerHour: emailguard.Limit(100), PerDay: emailguard.Limit(1000)},
		Rate:    emailguard.Rate{PerMinute: emailguard.Limit(20)},
	})
	send := g.Wrap(sendWithYourProvider)

	email := emailguard.Send{Key: "support-agent", To: []string{"ana@example.com"}, Subject: "Ticket 4521", Text: "We replied."}
	for i := 0; i < 4; i++ {
		var refused *emailguard.RefusedError
		if err := send(context.Background(), email); errors.As(err, &refused) {
			fmt.Println(refused.Decision.Reason)
		}
	}
	// Output: loop_repetition_detected
}

func ExampleGuard_Check() {
	g := emailguard.New(emailguard.Config{Budgets: emailguard.Budgets{PerDay: emailguard.Limit(1)}, Loop: emailguard.Loop{Mode: emailguard.LoopOff}})
	ctx := context.Background()
	s := emailguard.Send{Key: "billing-agent", To: []string{"a@example.com"}, Subject: "Invoice", Text: "Attached."}

	d, _ := g.Check(ctx, s)
	fmt.Println(d.Outcome)
	// ... the provider accepted it:
	_ = g.Record(ctx, s)

	d, _ = g.Check(ctx, s)
	fmt.Println(d.Outcome, d.Reason)
	// Output:
	// allow
	// refuse agent_budget_exceeded
}

func ExampleKillSwitch() {
	g := emailguard.New(emailguard.Config{})
	ctx := context.Background()
	_, _ = g.KillSwitch().Pause(ctx, "Agent looped on one inbox.", "on-call")

	d, _ := g.Check(ctx, emailguard.Send{To: []string{"a@example.com"}})
	fmt.Println(d.Message)

	resumed, _ := g.KillSwitch().Resume(ctx, "on-call")
	fmt.Println(resumed)
	// Output:
	// Sending is paused by the kill switch, so nothing sends until a person resumes it.
	// true
}
