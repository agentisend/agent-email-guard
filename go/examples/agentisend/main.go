// Command agentisend guards the AgentiSend Go SDK. The guard checks in your
// process; AgentiSend checks the same rules again at the API, where an agent
// that skips the guard still cannot get past its key's limits.
//
//	AGENTISEND_API_KEY=as_... go run ./agentisend
package main

import (
	"context"
	"fmt"
	"log"

	emailguard "github.com/agentisend/agent-email-guard/go"
	agentisend "github.com/fortuneflick/agentisend-go"
)

// Email is the request the example sends.
type Email struct {
	From, To, Subject, Text string
}

func guardedSend(g *emailguard.Guard, client *agentisend.Client) func(context.Context, Email) (map[string]any, error) {
	return emailguard.WrapFunc(g,
		func(e Email) emailguard.Send {
			return emailguard.Send{To: []string{e.To}, Subject: e.Subject, Text: e.Text}
		},
		func(ctx context.Context, e Email) (map[string]any, error) {
			return client.PostEmails(map[string]any{"from": e.From, "to": []string{e.To}, "subject": e.Subject, "text": e.Text})
		})
}

func main() {
	client, err := agentisend.New("", "") // reads AGENTISEND_API_KEY
	if err != nil {
		log.Fatal(err)
	}
	g := emailguard.New(emailguard.Config{Budgets: emailguard.Budgets{PerHour: emailguard.Limit(50)}, Approval: emailguard.Approval{NewRecipients: true}})
	send := guardedSend(g, client)
	sent, err := send(context.Background(), Email{From: "Agent <agent@example.com>", To: "customer@example.com", Subject: "Welcome", Text: "Your account is ready."})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("sent", sent["id"])
}
