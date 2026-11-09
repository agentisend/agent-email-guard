# agent-email-guard for Go

Blast-radius control for agents that send email: per-key budgets, a per-minute rate ceiling, loop detection, a
kill switch and approval holds. Works in front of any provider: SMTP, Amazon SES, Resend, AgentiSend, or your own
HTTP call.

```bash
go get github.com/agentisend/agent-email-guard/go
```

Go 1.22 or newer. Package `emailguard`; the core has no third-party dependencies.

## Example

```go
import emailguard "github.com/agentisend/agent-email-guard/go"

g := emailguard.New(emailguard.Config{
	Budgets:  emailguard.Budgets{PerHour: emailguard.Limit(100), PerDay: emailguard.Limit(1000)},
	Rate:     emailguard.Rate{PerMinute: emailguard.Limit(20)},
	Approval: emailguard.Approval{Recipients: []string{"@bigcustomer.com"}},
})
send := g.Wrap(yourSendFunc) // func(ctx, emailguard.Send) error

err := send(ctx, emailguard.Send{Key: "support-agent", To: []string{"ana@example.com"}, Subject: "Ticket 4521", Text: "We replied."})
var refused *emailguard.RefusedError       // budget, ceiling, loop, kill switch, suppression
var held *emailguard.ApprovalRequiredError // waits for a person; held.Approve(ctx) sends it once they say yes
```

`emailguard.WrapFunc` wraps a provider call with its own request and response types, so the guarded function keeps
the SDK's signature. See [examples/](examples/) for net/smtp, the AWS SDK v2 (SESv2), resend-go and the AgentiSend
Go SDK; each one runs in `go test` against a local stub.

## Policy file

The declarative part of the config can live in `agent-email-guard.json`, the same file the Node, Python and PHP
packages read:

```json
{
  "version": 1,
  "key": "support-agent",
  "budgets": { "per_hour": 50, "per_day": 300 },
  "rate": { "per_minute": 10 },
  "approval": { "recipients": ["@bigcustomer.com"] },
  "suppress": ["@competitor.example"]
}
```

```go
cfg, err := emailguard.LoadPolicy(emailguard.PolicyFile) // rejects unknown keys and wrong types, naming each one
cfg.Store = redisstore.New(rdb)                          // the store, clock and RequireFor stay in code
g := emailguard.New(cfg)
```

## What it checks

`Check` runs these in order and stops at the first block. Every decision carries an outcome (`allow`,
`hold_for_approval`, `refuse`), a stable reason token, one sentence and the evidence behind it.

| Order | Check | Outcome | Reason token |
|---|---|---|---|
| 1 | Kill switch | refuse | `kill_switch_active` |
| 2 | Suppression list | refuse | `recipient_suppressed` |
| 3 | Loop detection: 3 near-identical sends to the same To line in 60 minutes | refuse | `loop_repetition_detected` |
| 3 | Loop detection: recipients collapse below 3 effective inboxes over 20+ sends, and this send goes to one of them | refuse | `recipient_entropy_collapse` |
| 4 | Approval rules: listed recipients, your own `RequireFor`, new recipients | hold | `recipient_requires_approval` |
| 5 | Rate ceiling per key, sliding minute | refuse | `rate_ceiling_exceeded` |
| 6 | Budgets per key: hour, day, month, in UTC calendar periods | refuse | `agent_budget_exceeded` |

Loop thresholds are in `emailguard.LoopDefaults` and can be changed per guard. Near-identical means subject and
body trigram similarity of 0.85 or more.

`Check` reserves the send against the rate ceiling and every budget in one atomic step per counter, so 200
goroutines racing at a budget of 50 admit exactly 50 (`go test -race`). Call `Record` after the provider accepts
the send (it feeds loop detection and the new-recipient memory) or `Release` if the provider fails. `Wrap` and
`WrapFunc` do both for you.

```go
d, err := g.Check(ctx, send)
if err != nil { return err }       // the store failed
if !d.Allowed() { return d }       // d.Reason, d.Message, d.Evidence
if err := provider.Send(...); err != nil {
	_ = g.Release(ctx, d)
	return err
}
_ = g.Record(ctx, send)
```

The kill switch stops every key and never resumes on a timer:

```go
g.KillSwitch().Pause(ctx, "Agent looped on one inbox.", "on-call")
resumed, err := g.KillSwitch().Resume(ctx, "on-call") // false if it was not paused
```

## What it does not do

It limits how much damage a misbehaving agent can do by email: how many messages, how fast, how often the same
one, to whom without a person. It does not judge what a message says, and it does not stop an agent from being
talked into sending something; it caps how far that can go.

## Advisory here, enforced at AgentiSend

This library runs in the agent's own process. It catches a retry loop, a fan-out to 4,000 recipients, an agent that
keeps mailing one inbox. It cannot stop code that never calls it: an agent that holds a raw provider key can skip
it.

AgentiSend applies the same rules at its API. A key with a budget, a per-minute ceiling and loop holds is limited
on the server, so an agent that skips the library still cannot send past them; a paused key stays paused until a
person resumes it in the console; held sends wait in an approval queue the key cannot approve itself. The
`agentisend` sub-package returns those server refusals as the same `*emailguard.RefusedError` and
`*emailguard.ApprovalRequiredError`, so one error path covers both.

## Integrations

**AgentiSend** (enforced at the API):

```go
import "github.com/agentisend/agent-email-guard/go/agentisend"

client := agentisend.New("") // reads AGENTISEND_API_KEY
d, err := client.Check(ctx, email) // POST /emails/preflight: every gate, nothing sent
sent, err := client.Send(ctx, agentisend.Email{
	From: "Acme <hello@acme.com>", To: []string{"ana@example.com"}, Subject: "Ticket 4521", Text: "We replied.",
}, idempotencyKey)

client.SetLimits(ctx, keyID, agentisend.Limits{BudgetPerPeriod: emailguard.Limit(500), Period: "daily", RateCeilingPerMinute: emailguard.Limit(20)})
client.Kill(ctx, keyID, "Looping on one inbox.")
pending, err := client.Actions(ctx, "pending")
```

A key may lower its own limits. Raising one, resuming a paused key and approving a held send are a person's
decisions, made in the console, so `Resume` and a hosted hold's `Approve` return an error that says so.

**Any other provider**: wrap its send call with `g.Wrap` or `emailguard.WrapFunc`. Examples:
[net/smtp](examples/smtp/main.go), [Amazon SES v2](examples/sesv2/main.go), [resend-go](examples/resend/main.go),
[AgentiSend Go SDK](examples/agentisend/main.go).

## Stores

| Store | Use it when | Import |
|---|---|---|
| `emailguard.NewMemoryStore()` (default) | one process | core |
| `redisstore.New(rdb)` | several processes share budgets; go-redis v9, one Lua script per atomic step | `github.com/agentisend/agent-email-guard/go/redisstore` |
| `pgstore.New(db, opts)` | you already run Postgres; any `database/sql` driver; `Migrate` creates 4 tables | `github.com/agentisend/agent-email-guard/go/pgstore` |

Redis and Postgres use the data layout in the spec (key names, a send log of JSON records, tables
`agent_email_guard_*`), so a Go worker and a Node or Python agent on one database share one budget, one rate window
and one kill switch. Two processes with their own memory stores enforce two separate budgets. The store modules are
separate, so the core keeps zero dependencies. To write your own store, implement `emailguard.Store` and run
`storetest.Run(t, newStore)` against it: it checks that the two atomic steps stay atomic under 100 concurrent
callers.

## Same behaviour in four languages

The Node, Python, PHP and Go packages share one spec and one set of JSON test vectors in `../spec/vectors`. Reason
tokens and every sentence are byte-identical across them. `go test ./...` runs every vector.

## License

MIT. Copyright AgentiSend.
