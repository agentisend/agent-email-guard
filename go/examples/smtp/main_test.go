package main

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

// fakeSMTP accepts mail on a local port and counts DATA commands.
func fakeSMTP(t *testing.T) (addr string, delivered func() int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var mu sync.Mutex
	n := 0
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				w := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
				w("220 fake ESMTP")
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					cmd := strings.ToUpper(strings.TrimSpace(line))
					switch {
					case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
						w("250 fake")
					case cmd == "DATA":
						w("354 go ahead")
						for {
							l, err := r.ReadString('\n')
							if err != nil || l == ".\r\n" {
								break
							}
						}
						mu.Lock()
						n++
						mu.Unlock()
						w("250 queued")
					case cmd == "QUIT":
						w("221 bye")
						return
					default:
						w("250 ok")
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().String(), func() int { mu.Lock(); defer mu.Unlock(); return n }
}

func TestSMTPExample(t *testing.T) {
	addr, delivered := fakeSMTP(t)
	g := emailguard.New(emailguard.Config{Budgets: emailguard.Budgets{PerHour: emailguard.Limit(2)}, Loop: emailguard.Loop{Mode: emailguard.LoopOff}})
	send := newSender(g, addr, nil, "agent@example.com")
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := send(ctx, emailguard.Send{To: []string{"c@example.com"}, Subject: "Hi", Text: "Hello."}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	err := send(ctx, emailguard.Send{To: []string{"c@example.com"}, Subject: "Hi", Text: "Hello."})
	var refused *emailguard.RefusedError
	if !errors.As(err, &refused) || refused.Decision.Reason != emailguard.ReasonAgentBudgetExceeded {
		t.Fatalf("third send: %v", err)
	}
	if delivered() != 2 {
		t.Fatalf("relay got %d messages, want 2", delivered())
	}
}
