// Command smtp guards net/smtp: budgets, a rate ceiling and loop detection in
// front of any SMTP relay.
//
//	SMTP_ADDR=smtp.example.com:587 SMTP_USER=... SMTP_PASS=... go run ./smtp
package main

import (
	"context"
	"fmt"
	"log"
	"net/smtp"
	"os"
	"strings"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

// newSender returns a guarded send function for one SMTP relay.
func newSender(g *emailguard.Guard, addr string, auth smtp.Auth, from string) emailguard.SendFunc {
	return g.Wrap(func(ctx context.Context, s emailguard.Send) error {
		msg := "From: " + from + "\r\n" +
			"To: " + strings.Join(s.To, ", ") + "\r\n" +
			"Subject: " + s.Subject + "\r\n" +
			"Content-Type: text/plain; charset=utf-8\r\n\r\n" + s.Text + "\r\n"
		rcpt := append(append(append([]string{}, s.To...), s.Cc...), s.Bcc...)
		return smtp.SendMail(addr, auth, from, rcpt, []byte(msg))
	})
}

func main() {
	g := emailguard.New(emailguard.Config{
		Budgets: emailguard.Budgets{PerHour: emailguard.Limit(100), PerDay: emailguard.Limit(1000)},
		Rate:    emailguard.Rate{PerMinute: emailguard.Limit(20)},
	})
	addr := os.Getenv("SMTP_ADDR")
	host := strings.Split(addr, ":")[0]
	auth := smtp.PlainAuth("", os.Getenv("SMTP_USER"), os.Getenv("SMTP_PASS"), host)
	send := newSender(g, addr, auth, "agent@example.com")

	err := send(context.Background(), emailguard.Send{
		Key: "support-agent", To: []string{"customer@example.com"},
		Subject: "Your ticket was updated", Text: "We replied to ticket 4521.",
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("sent")
}
