// Command resend guards the resend-go SDK. Same request, same response; the
// guard sits in between.
//
//	RESEND_API_KEY=re_... go run ./resend
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/resend/resend-go/v2"
)

func describe(req *resend.SendEmailRequest) emailguard.Send {
	return emailguard.Send{To: req.To, Cc: req.Cc, Bcc: req.Bcc, Subject: req.Subject, Text: req.Text, HTML: req.Html}
}

func guardedSend(g *emailguard.Guard, client *resend.Client) func(context.Context, *resend.SendEmailRequest) (*resend.SendEmailResponse, error) {
	return emailguard.WrapFunc(g, describe, client.Emails.SendWithContext)
}

func main() {
	client := resend.NewClient(os.Getenv("RESEND_API_KEY"))
	g := emailguard.New(emailguard.Config{
		Budgets:  emailguard.Budgets{PerDay: emailguard.Limit(200)},
		Approval: emailguard.Approval{Recipients: []string{"@bigcustomer.com"}},
	})
	send := guardedSend(g, client)
	sent, err := send(context.Background(), &resend.SendEmailRequest{
		From: "Agent <agent@example.com>", To: []string{"customer@example.com"},
		Subject: "Your export is ready", Text: "Download it from the dashboard.",
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("sent", sent.Id)
}
