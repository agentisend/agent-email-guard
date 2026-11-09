# agent-email-guard

Blast-radius control for agents that send email. It caps how much an agent can send and to whom, stops loops, holds chosen sends for a person, and gives you one call that stops everything. It works in front of any provider: AgentiSend, Resend, Amazon SES, SMTP, or your own function.

It limits volume, repetition and recipients. It does not read intent or detect prompt injection; an agent tricked into sending one bad email within its limits still sends it.

```bash
pip install agent-email-guard
```

Python 3.9 or newer. No runtime dependencies. Redis and Postgres stores are optional extras.

## Twelve lines

```python
from agent_email_guard import ApprovalRequired, Guard, GuardRefused

guard = Guard(
    budgets={"per_hour": 50, "per_day": 500},
    rate={"per_minute": 10},
    suppress=["@competitor.example"],
)
send = guard.wrap(provider.send)  # any function that takes one email dict

try:
    send({"to": "customer@example.com", "subject": "Your receipt", "text": "Thanks."})
except (GuardRefused, ApprovalRequired) as stop:
    print(stop.decision.reason, stop.decision.message)
```

`wrap()` keeps the function's signature. Each call is checked, sent, and recorded. If the provider raises, the reservation is given back and the provider's error reaches you unchanged.

## What it decides

Every check returns a `Decision` with four fields. `outcome` is `allow`, `hold_for_approval` or `refuse`. `reason` is a stable token. `message` is one sentence a person can read. `evidence` holds the numbers behind it:

```python
>>> guard.check({"to": "ops@example.com", "subject": "Disk at 91%", "text": "db-1"})
Decision(outcome='refuse', reason='loop_repetition_detected',
         message='Blocked: 3 near-identical emails already went to ops@example.com within 60 minutes, which matches a retry or script loop; review the agent before sending more.',
         evidence={'matching_sends_in_window': 3, 'repetition_threshold': 3, 'window_ms': 3600000, ...})
```

Checks run in this order and stop at the first block:

| # | Check | Outcome | Reason |
|---|---|---|---|
| 1 | Kill switch | refuse | `kill_switch_active` |
| 2 | Suppression list | refuse | `recipient_suppressed` |
| 3 | Loop detection | refuse | `loop_repetition_detected`, `recipient_entropy_collapse` |
| 4 | Approval rules | hold | `recipient_requires_approval` |
| 5 | Rate ceiling (sliding minute) | refuse | `rate_ceiling_exceeded` |
| 6 | Budgets (UTC hour, day, month) | refuse | `agent_budget_exceeded` |
| 7 | | allow | `ok` |

Steps 1 to 4 reserve nothing. Steps 5 and 6 reserve atomically: 200 concurrent checks against a budget of 50 allow exactly 50 (the test suite runs this with threads and with asyncio).

**Loop detection** uses two signals. The first is repetition: the agent has already sent 3 emails to the same To line within 60 minutes, with subject and body at least 85% similar (trigram Jaccard). The second is recipient collapse: across 20 or more recent sends, the effective number of recipients has dropped below 3. A collapsed window holds only a send to one of the inboxes it collapsed on. A sign-in code to a new user still goes out. Both signals and all five thresholds are configurable (`LOOP_DEFAULTS`). `loop={"mode": "repetition_only"}` turns off the collapse signal, and `loop=False` turns off both.

**Approvals.** `approval={"recipients": ["@bigcustomer.com"]}` holds any send to that domain. `approval={"new_recipients": True}` holds a send to any address this key has never sent to. `approval={"require_for": fn}` holds a send whenever your function returns something truthy. Keep held sends wherever you like, then call `stop.approve()` once a person says yes. Every other check runs again before the email goes out.

**Kill switch.** `guard.kill_switch.pause("looping on one inbox", by="ops")` stops every send through this guard, for every key, until someone calls `guard.kill_switch.resume("ops")`. There is no timer. A paused guard is still paused a year later.

**Keys.** A send can name the agent it belongs to with `"key": "billing-agent"`. Each key gets its own budget, rate window, loop window and seen-recipient memory.

## Policy file

Keep the limits in `agent-email-guard.json` next to your code instead of inside it. The same file configures the Node, PHP and Go ports. An unknown key or a wrong type rejects the whole file with a sentence naming the key.

```json
{
  "version": 1,
  "key": "support-agent",
  "budgets": {"per_hour": 50, "per_day": 500},
  "rate": {"per_minute": 10},
  "approval": {"new_recipients": true, "recipients": ["@bigcustomer.com"]},
  "suppress": ["@competitor.example"]
}
```

```python
guard = Guard.from_policy()                       # reads ./agent-email-guard.json
guard = Guard.from_policy("config/agent-email-guard.json", require_for=my_rule, store=store)
```

`require_for` is code, so it is passed in, never read from the file. Keyword arguments override the file.

## Advisory here, enforced at AgentiSend

This library runs inside the agent's own process. That makes it advisory. An agent that edits its own code, skips `check()`, or starts a second process with a fresh in-memory store can get around it. For many teams that is enough: the failure it catches is the agent stuck in a retry loop, not an agent fighting its operator.

When you need limits the agent cannot remove, AgentiSend enforces the same rules at its API, on the API key itself. The rules are budget, per-minute ceiling, loop detection, approval queue and kill switch. Every process using that key shares them, and a paused key cannot resume itself: only a person signed in to the console can.

```python
from agent_email_guard.agentisend import AgentiSendGuard

hosted = AgentiSendGuard(key_id="your-api-key-id")   # reads AGENTISEND_API_KEY
hosted.apply_limits(budgets={"per_day": 500}, rate={"per_minute": 10})
hosted.check(email)        # POST /emails/preflight: runs every gate, sends nothing
hosted.send(email)         # POST /emails: raises GuardRefused / ApprovalRequired like the local guard
hosted.kill_switch.pause("looping")
hosted.approvals.list()    # held sends waiting for a person
```

A key can lower its own limits. Raising a limit is a person's decision, made in the console.

## Integrations

Each one is a runnable file in [`examples/`](examples/). The test suite runs every example against a stub.

- **AgentiSend** ([`agentisend_sdk.py`](examples/agentisend_sdk.py)): `guard.wrap(AgentiSend().send_email)`, with the hosted adapter above for enforcement.
- **Resend** ([`resend_sdk.py`](examples/resend_sdk.py)): `guard.wrap(resend.Emails.send)`.
- **Amazon SES** ([`boto3_ses.py`](examples/boto3_ses.py)): `guard.wrap(ses.send_email, extract=...)`, which maps SES's keyword arguments to a send.
- **SMTP** ([`smtp_stdlib.py`](examples/smtp_stdlib.py)): `smtplib` and `email.message`, standard library only.
- **LangChain and the OpenAI Agents SDK** ([`agent_tool.py`](examples/agent_tool.py)): a `send_email` tool that returns the guard's sentence instead of raising. The model reads why a send was refused and does not retry in a loop.

## Sharing limits across processes

The in-memory store counts for one process. To share budgets, the rate window, the loop log and the kill switch across processes, use one of these:

```python
# pip install "agent-email-guard[redis]"
import redis
from agent_email_guard.stores.redis import RedisStore
guard = Guard(budgets={"per_day": 500}, store=RedisStore(redis.Redis.from_url("redis://localhost:6379/0")))

# pip install "agent-email-guard[postgres]"
import psycopg
from agent_email_guard.stores.postgres import PostgresStore
store = PostgresStore(psycopg.connect("postgresql://localhost/app", autocommit=True))
store.setup()  # creates four agent_email_guard_* tables if missing
guard = Guard(budgets={"per_day": 500}, store=store)
```

Redis runs every check-and-reserve as one Lua script. Postgres uses one conditional upsert per counter, plus an advisory lock around the rate window. Store key names are shared with the Node, PHP and Go ports of agent-email-guard, so agents written in different languages can share one budget.

## asyncio

```python
from agent_email_guard import AsyncGuard
from agent_email_guard.stores.redis import AsyncRedisStore   # or AsyncPostgresStore, or the default in-memory store

guard = AsyncGuard(budgets={"per_day": 500}, rate={"per_minute": 10})
send = guard.wrap(async_provider_send)      # wraps an async function
decision = await guard.check(email)          # require_for may be async here
```

## Without wrap

```python
decision = guard.check(email)
if decision.outcome == "allow":
    try:
        provider.send(email)
    except Exception:
        guard.release(decision)   # give back the reservation
        raise
    guard.record(email)           # feeds loop detection and new-recipient memory
```

`decision.reservation.to_dict()` is plain JSON, so a decision can be released from a different process.

## Conformance

Every port of agent-email-guard (Node, Python, PHP, Go) passes the same 45 conformance cases in [`../spec/vectors`](../spec/vectors). They pin each reason token, each sentence byte for byte, and each evidence field. The specification is [`../spec/SPEC.md`](../spec/SPEC.md).

## License

MIT. Copyright AgentiSend.
