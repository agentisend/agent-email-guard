package main

import "github.com/tmc/langchaingo/llms"

func deliver(api interface{ Send(v any) error }) error {
	_ = llms.Text
	return api.SendEmail(struct{}{})
}
