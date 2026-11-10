# agent-email-guard

Blast-radius control for agents that send email: at most N sends an hour, M a minute, no repeated messages, no mail to an important or new recipient without a person, and one call that stops everything. Works in front of nodemailer, Amazon SES, Resend, Postmark, any SMTP server, or AgentiSend.

```bash
npm install agent-email-guard                         # Node / TypeScript
pip install agent-email-guard                         # Python
composer require agentisend/agent-email-guard         # PHP
go get github.com/agentisend/agent-email-guard/go     # Go
```

```ts
import { createGuard } from 'agent-email-guard';

const guard = createGuard({
  budgets: { perHour: 50, perDay: 300 },     // per key, UTC calendar periods
  rate: { perMinute: 10 },                   // sliding minute
  loop: { mode: 'full' },                    // repetition + recipient collapse
  approval: { recipients: ['@bigcustomer.com'], newRecipients: true },
});

const sendMail = guard.wrap((mail) => transporter.sendMail(mail));
await sendMail({ from: 'agent@yourapp.com', to: 'ana@example.com', subject: 'Your refund', text: 'Done.' });
// Refused → throws GuardRefused. Needs a person → throws ApprovalRequired; err.approve() sends it.
```

Every decision is one of `allow`, `hold_for_approval` or `refuse`, with a stable reason token, one human sentence and the numbers behind it:

```json
{
  "outcome": "refuse",
  "reason": "loop_repetition_detected",
  "message": "Blocked: 3 near-identical emails already went to ana@example.com within 60 minutes, which matches a retry or script loop; review the agent before sending more.",
  "evidence": { "matching_sends_in_window": 3, "repetition_threshold": 3, "closest_body_similarity": 1, "window_ms": 3600000 }
}
```

## What it stops

| Failure | Rule | Default |
|---|---|---|
| A retry loop sends one message 4,000 times | Refuse the 4th near-identical send (same To, subject and body ≥ 0.85 trigram similarity) inside 60 minutes | on |
| A loop rewrites each message but keeps mailing the same one or two inboxes | Refuse a send to an inbox holding ≥ 1/3 of a 20+ send window whose effective recipient count fell below 3 | on |
| An agent burns through a month of sending in an afternoon | Per-key hourly, daily and monthly budgets, reserved atomically | off until set |
| A burst that a provider or a recipient's server would throttle | Per-key sliding one-minute ceiling | off until set |
| Something is wrong and every agent must stop now | `guard.killSwitch.pause(reason)`; never resumes on a timer | — |
| Mail to an important customer, a new address, or anything your own rule flags | Hold for a person; `err.approve()` re-checks and sends | off until set |
| Addresses the agent must never mail | Suppression list, refused outright | off until set |

Mail to everyone else keeps flowing: a key that pages its owner 30 times an hour still sends a sign-in code to a new user.

## Advisory here, enforced at AgentiSend

agent-email-guard runs inside your agent's process. That makes it easy to adopt, and it also means code the agent controls can remove it, and two processes with the in-memory store keep two separate budgets. Use the Redis or Postgres store to share limits across processes.

[AgentiSend](https://agentisend.com) enforces the same rules at the API, where the agent cannot bypass them: the budget, rate ceiling and kill switch live on the API key and apply to every process that uses it, a key can lower its own limits but never raise them, a paused key cannot resume itself, holds wait in an approval queue in the console, and the thresholds are published. The `agent-email-guard/agentisend` adapter speaks to it with the same decision shape:

```ts
import { createHostedGuard } from 'agent-email-guard/agentisend';

const guard = createHostedGuard({ apiKey: process.env.AGENTISEND_API_KEY, keyId: process.env.AGENTISEND_KEY_ID });
const decision = await guard.check(email);   // POST /emails/preflight: every send gate, nothing sent
await guard.send(email);                     // POST /emails: throws GuardRefused / ApprovalRequired
await guard.killSwitch.pause('Looping on one inbox.');
```

## One policy file, every language

Put the limits in `agent-email-guard.json` and load it from Node, Python, PHP or Go:

```json
{ "key": "support-agent", "budgets": { "per_hour": 50 }, "rate": { "per_minute": 10 }, "approval": { "recipients": ["@bigcustomer.com"] } }
```

```bash
npx agent-email-guard validate                           # check the file
echo '{"to":"cto@bigcustomer.com"}' | npx agent-email-guard check   # exit 0 allow, 2 hold, 3 refuse
```

## Integrations

- **AgentiSend**: local guard around the SDK, or the hosted adapter above ([example](node/examples/agentisend.ts))
- **nodemailer**: `transporter.use('compile', nodemailerGuard(loadPolicy()))`, or `guard.wrap((mail) => transporter.sendMail(mail))` ([example](node/examples/nodemailer.ts))
- **Amazon SES** (SDK v3): wrap `client.send(new SendEmailCommand(input))` with a five-line field mapping ([example](node/examples/ses.ts))
- **Resend**: wrap `resend.emails.send` and throw on `{ error }` ([example](node/examples/resend.ts)). For a cap with no code change, [`agent-email-guard-proxy`](resend-proxy/) speaks `POST /emails` and `POST /emails/batch`, checks each message, and forwards an allowed request unchanged. It is not affiliated with Resend.
- **Postmark**: wrap `client.sendEmail({ From, To, Subject, TextBody })` with `toGuardSend: (m) => ({ to: m.To, subject: m.Subject, text: m.TextBody, html: m.HtmlBody })`
- **SMTP**: any client, same pattern as nodemailer
- **OpenAI Agents SDK**: `tool({ ..., inputGuardrails: [emailInputGuardrail(guard)] })`; a refusal becomes the content the model reads
- **Vercel AI SDK**: an agent tool whose send is wrapped, so a refusal becomes the tool result the model reads ([example](node/examples/vercel-ai-tool.ts))
- **LangChain / LangGraph, Mastra, CrewAI, OpenAI Agents (JS and Python), Vercel AI SDK**: tested tool wrappers in [integrations/](integrations/); a hold becomes a LangGraph `interrupt()` or a Mastra `suspend`, and an approved resume still goes through the budgets

## CI check

[action/](action/) is a GitHub Action, `agent-email-guard check`. It warns when a pull request adds an email send in agent code and that file does not import the guard and no `agent-email-guard.json` covers it. `fail: true` makes the check exit 1. The action reads the checkout and does not call the network.

## Coding-agent skill

`npx skills add agentisend/agent-email-guard` installs the `agent-email-safety` [Agent Skill](skills/agent-email-safety/SKILL.md) for Claude Code, Cursor, Codex and other agents that read `SKILL.md`. It tells the coding agent to wrap any send path it writes, install the hook, and keep the caps. A Cursor rule ([rules/agent-email-safety.mdc](rules/agent-email-safety.mdc)) and `AGENTS.md` / `CLAUDE.md` snippets are in [skills/](skills/).

## Languages

| Language | Package | Directory |
|---|---|---|
| Node / TypeScript | `agent-email-guard` | [node/](node/) |
| Python | `agent-email-guard` (`import agent_email_guard`) | [python/](python/) |
| PHP | `agentisend/agent-email-guard` (`AgentiSend\AgentEmailGuard`) | [php/](php/) |
| Go | `github.com/agentisend/agent-email-guard/go` (package `emailguard`) | [go/](go/) |

All four implement one [specification](spec/SPEC.md) and pass the same [conformance vectors](spec/vectors/): byte-identical reason tokens and messages, the same check order, and one Redis/Postgres layout, so a Node agent and a Python worker can share a budget.

## License

MIT. Copyright AgentiSend. See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
