// Command sesv2 guards Amazon SES (AWS SDK for Go v2, SESv2 SendEmail).
//
//	AWS_REGION=us-east-1 go run ./sesv2
package main

import (
	"context"
	"fmt"
	"log"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// describe tells the guard what an SES request sends.
func describe(in *sesv2.SendEmailInput) emailguard.Send {
	s := emailguard.Send{}
	if in.Destination != nil {
		s.To, s.Cc, s.Bcc = in.Destination.ToAddresses, in.Destination.CcAddresses, in.Destination.BccAddresses
	}
	if in.Content != nil && in.Content.Simple != nil {
		m := in.Content.Simple
		if m.Subject != nil {
			s.Subject = aws.ToString(m.Subject.Data)
		}
		if m.Body != nil && m.Body.Text != nil {
			s.Text = aws.ToString(m.Body.Text.Data)
		}
		if m.Body != nil && m.Body.Html != nil {
			s.HTML = aws.ToString(m.Body.Html.Data)
		}
	}
	return s
}

// guardedSend wraps the SES client's SendEmail; the result has the same
// request and response types.
func guardedSend(g *emailguard.Guard, client *sesv2.Client) func(context.Context, *sesv2.SendEmailInput) (*sesv2.SendEmailOutput, error) {
	return emailguard.WrapFunc(g, describe, func(ctx context.Context, in *sesv2.SendEmailInput) (*sesv2.SendEmailOutput, error) {
		return client.SendEmail(ctx, in)
	})
}

func message(to, subject, text string) *sesv2.SendEmailInput {
	return &sesv2.SendEmailInput{
		FromEmailAddress: aws.String("agent@example.com"),
		Destination:      &types.Destination{ToAddresses: []string{to}},
		Content: &types.EmailContent{Simple: &types.Message{
			Subject: &types.Content{Data: aws.String(subject)},
			Body:    &types.Body{Text: &types.Content{Data: aws.String(text)}},
		}},
	}
}

func main() {
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatal(err)
	}
	g := emailguard.New(emailguard.Config{Budgets: emailguard.Budgets{PerDay: emailguard.Limit(500)}, Rate: emailguard.Rate{PerMinute: emailguard.Limit(14)}})
	send := guardedSend(g, sesv2.NewFromConfig(cfg))
	out, err := send(ctx, message("customer@example.com", "Your receipt", "Order 1182 is paid."))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("sent", aws.ToString(out.MessageId))
}
