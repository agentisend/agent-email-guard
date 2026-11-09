# agent-email-guard specification

Version 0.1 (2026-11-09). This document and `vectors/*.json` are the contract every implementation (Node, Python, PHP, Go) meets. Where they disagree, the vectors win and this document is fixed.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. What it is

agent-email-guard is blast-radius control for agents that send email: at most N recipients a key may reach without a person, M sends an hour, no repeated sends, nothing over a threshold without a human. Before an AI agent sends an email, it decides whether the send is allowed, held for a person, or refused. It runs in the agent's own process, in front of any email provider. It enforces:

- **budgets**: emails per key per UTC hour, day and month;
- **a rate ceiling**: emails per key per sliding minute;
- **loop detection**: repeated near-identical sends, and recipient lists that collapse onto one or two inboxes;
- **a kill switch**: one call stops every send until a person resumes it;
- **approval holds**: sends that wait for a person (listed recipients, new recipients, or your own rule);
- **a suppression list**: recipients the guard never sends to.

It is advisory. Code that the agent controls can remove it. The hosted adapter (§8) enforces the same rules at the AgentiSend API, where the agent cannot bypass them.

## 2. Public API

### 2.0 Package names

| Language | Package | Import |
|---|---|---|
| Node / TypeScript | npm `agent-email-guard` (also the CLI: `npx agent-email-guard`) | `agent-email-guard`, subpaths `/redis`, `/postgres`, `/agentisend`, `/policy`, `/nodemailer`, `/openai-agents` |
| Python | PyPI `agent-email-guard` | `agent_email_guard` |
| PHP | Packagist `agentisend/agent-email-guard` | namespace `AgentiSend\AgentEmailGuard` |
| Go | module `github.com/agentisend/agent-email-guard/go` | package `emailguard` |

Public repository: `github.com/agentisend/agent-email-guard`. Policy file: `agent-email-guard.json` (§2.9). Default store namespace: `agent-email-guard`; default Postgres table prefix: `agent_email_guard`.


Names below are the Node names. Ports use their language's casing (`create_guard`, `CreateGuard`, `createGuard`) and the same structure.

```
createGuard(config) -> Guard

Guard.check(send, options?) -> Decision          async
Guard.record(send)                               async; after the provider accepted
Guard.release(decision)                          async; after the provider failed
Guard.wrap(sendFn, options?) -> wrapped sendFn
Guard.killSwitch.pause(reason, by?) -> KillSwitchState
Guard.killSwitch.resume(by) -> bool
Guard.killSwitch.state() -> KillSwitchState

GuardRefused        error carrying .decision (outcome refuse)
ApprovalRequired    error carrying .decision (outcome hold_for_approval) and .approve()
```

### 2.1 Config

| Field | Type | Default | Meaning |
|---|---|---|---|
| `key` | string | `"default"` | The key a send counts against when the send names none. |
| `budgets.perHour` / `perDay` / `perMonth` | integer ≥ 0 | unset (no budget) | Emails per key per UTC calendar hour, day, month. |
| `rate.perMinute` | integer ≥ 0 | unset (no ceiling) | Emails per key per sliding 60,000 ms. |
| `loop.mode` | `"full"` \| `"repetition_only"` \| `"off"` | `"full"` | Which loop signals run (§5). |
| `loop.windowMs` | integer | 3,600,000 | Loop window. |
| `loop.similarityThreshold` | number | 0.85 | Subject and body similarity at or above this are near-identical. |
| `loop.maxIdenticalSends` | integer | 3 | Refuse when this many near-identical sends are already in the window. |
| `loop.minWindowForEntropy` | integer | 20 | Entropy is only trusted on at least this many sends. |
| `loop.recipientPerplexityFloor` | number | 3 | Collapse when effective recipients fall below this. |
| `approval.recipients` | string[] | `[]` | Rules (§3.3) that hold a send for a person. |
| `approval.newRecipients` | bool | false | Hold a send when any recipient has no recorded send from this key. |
| `approval.requireFor` | callback(send) → bool \| string \| null | unset | Your rule. Truthy holds; a string becomes `evidence.detail`. MAY be async. |
| `suppress` | string[] | `[]` | Rules (§3.3) the guard refuses outright. |
| `store` | Store | in-memory | §6. |
| `clock` | () → epoch ms | system clock | Injected for tests. |
| `namespace` | string | `"agent-email-guard"` | Prefix of every store name. |

`LOOP_DEFAULTS` is exported with the five loop numbers above plus `mode: "full"`.

### 2.2 Send

A send is a provider-neutral map:

| Field | Type | Notes |
|---|---|---|
| `key` | string | optional; falls back to `config.key`, then `"default"` |
| `to` | address field | required |
| `cc`, `bcc` | address field | optional |
| `from` | address field | optional; not used by any rule in 0.1 |
| `subject` | string | optional, default `""` |
| `text` | string | optional |
| `html` | string | optional; the body is `text` when it is a non-empty string, else `html`, else `""` |

An **address field** is a string, an object with `address` (or `email`), or a list of those. A string splits on `,`.

### 2.3 Decision

```
{
  outcome:  "allow" | "hold_for_approval" | "refuse",
  reason:   one of REASON_TOKENS (§4),
  message:  one sentence ending in ".", rendered from §4.2,
  evidence: map of string → string | number | bool | null,
  reservation?: opaque, present on an allow that reserved budget or rate
}
```

`reason` is `"ok"` exactly when `outcome` is `"allow"`. `reservation` is what `release()` gives back; it MUST be serializable so a decision can cross a process boundary. It is not part of the vectors.

### 2.4 check(send, {approved})

Runs the checks of §7 in order and returns the first block, or `allow`. It MUST be safe to call concurrently: two checks racing for the last unit of budget MUST NOT both be allowed (§6.2). `approved: true` means a person approved this send: the approval rules (step 4) are skipped, every other check still runs, and an `allow` carries `evidence.approved = true`.

### 2.5 record(send)

Call after the provider accepted the send. Appends the send to the key's log (loop detection reads it) and marks each recipient as seen for this key (`approval.newRecipients` reads that). A check alone records nothing: sends that were refused, held, or failed never feed loop detection.

### 2.6 release(decision)

Call when the provider failed after an `allow`. Gives back every counter and rate slot that check reserved. Releasing the same decision twice MUST change nothing the second time. Releasing a decision with no reservation is a no-op.

### 2.7 wrap(sendFn, {toGuardSend})

Returns a function with the same signature as `sendFn`. Each call: map the arguments to a send (default: the first argument as-is), `check`; on `refuse` throw `GuardRefused`; on `hold_for_approval` throw `ApprovalRequired`; on `allow` call `sendFn`, and on success `record` and return its result, on failure `release` and rethrow the provider's error unchanged.

`ApprovalRequired.approve()` re-runs the same call with `approved: true` and returns the provider's result (or throws `GuardRefused` if something else now blocks it). Where to keep held sends until a person decides is the caller's choice.

### 2.8 Kill switch

`pause(reason, by = "agent-email-guard")` stores `{paused_at, paused_by, reason}` and from then on every `check` on this guard (every key, same store and namespace) is refused with `kill_switch_active`. Pausing a paused guard overwrites the record; the latest pause is reported. There is no timer, TTL or expiry anywhere: a paused guard stays paused a year later. `resume(by)` returns `true` and clears the pause, or returns `false` and records nothing when the guard was not paused. Implementations MUST keep the cleared pause under `<namespace>:kill:last_resume` as exactly `{"paused_at", "paused_by", "reason", "resumed_at", "resumed_by"}` (§6.3), overwriting the previous one.

`state()` returns `{paused, pausedAt, pausedBy, reason}` (nulls when not paused).

### 2.9 Policy file

`agent-email-guard.json` holds the declarative part of the config in the snake_case keys of the vectors (§9), so one file configures every language:

```json
{
  "version": 1,
  "key": "support-agent",
  "budgets": { "per_hour": 50, "per_day": 300, "per_month": 5000 },
  "rate": { "per_minute": 10 },
  "loop": { "mode": "full", "window_ms": 3600000, "similarity_threshold": 0.85, "max_identical_sends": 3, "min_window_for_entropy": 20, "recipient_perplexity_floor": 3 },
  "approval": { "new_recipients": false, "recipients": ["@bigcustomer.com"] },
  "suppress": ["@competitor.example"]
}
```

Every key is optional. Top-level keys: `$schema` and `$comment` (any JSON value, ignored), `version` (must be `1`), `key` and `namespace` (non-empty strings; `namespace` sets the store namespace, §6.3), `budgets`, `rate`, `loop`, `approval` (objects with the keys above), `suppress` (list of strings). Integers are ≥ 0; `similarity_threshold` and `recipient_perplexity_floor` are numbers > 0.

Anything else is an error, and implementations MUST reject the file rather than ignore part of it. Problems are reported in this order: walk the policy's top-level keys in file order; for an object section, walk its keys in file order. The sentences are exactly:

- `The policy must be a JSON object.` (the whole file is not an object; nothing else is reported)
- `Unknown key "{key}".` / `Unknown key "{section}.{key}".`
- `"{key}" has the wrong type.` / `"{section}.{key}" has the wrong type.`
- `"{section}" must be an object.`

`vectors/policy/validation.json` pins them: each case has a `policy` and `expect.problems` (empty when valid). `requireFor`, the store and the clock stay in code.

## 3. Normalization

All case folding is ASCII-only (A–Z → a–z). Unicode case rules differ between runtimes; the vectors must not.

### 3.1 Addresses

For each address string: trim ASCII whitespace; if it ends with `<…>` (optionally followed by whitespace), take the part inside the brackets; trim again; ASCII-lowercase. Drop empty results. An address field yields its addresses in order with duplicates removed.

- **To line**: the normalized `to` addresses, sorted by byte value, joined with `,`. Repetition compares To lines.
- **Recipients**: `to`, then `cc`, then `bcc`, normalized, duplicates removed, first occurrence wins. Entropy, suppression, approval rules and new-recipient memory use recipients.

### 3.2 Text

`normalizeText(s)`: ASCII-lowercase, replace every maximal run of characters outside `[a-z0-9]` with one space, strip leading and trailing spaces. The subject is `normalizeText(subject)`; the body is `normalizeText(body)` cut to its first 4,096 characters (`BODY_COMPARE_CHARS`; the normalized text is ASCII, so characters and bytes agree).

**Trigrams** of a normalized string `n`: every 3-character substring of `"  " + n + " "` (two spaces before, one after), as a set. **Similarity** of two normalized strings: 1 when they are equal; otherwise the Jaccard index of their trigram sets, `|A∩B| / |A∪B|` (1 when both sets are empty).

### 3.3 Rules

A rule is an address or a domain. Normalize it as an address (§3.1). A rule starting with `@` matches a recipient that ends with it (`@bigco.com` matches `ceo@bigco.com`, not `ceo@sub.bigco.com`). Any other rule matches a recipient equal to it. The first match is found by walking recipients in order and, for each, rules in order. Messages and evidence report the normalized rule (`@BigCo.com` is reported as `@bigco.com`; `VIP <VIP@Partner.Example>` as `vip@partner.example`).

## 4. Reason tokens and messages

### 4.1 Formatting

- `round3(x) = floor(x × 1000 + 0.5) / 1000` (half up, not banker's rounding).
- A number prints as an integer with no decimal point when it is integral (`2`, not `2.0`), otherwise as the shortest decimal that round-trips (`2.828`, `0.333`). Node `String(x)`, Python `repr` with the integral case handled, Go `strconv.FormatFloat(x, 'f', -1, 64)`, PHP with `serialize_precision = -1`.
- `plural(n, word)` is `"<n> <word>"` when `n` is exactly 1, else `"<n> <word>s"`.
- An instant prints as `YYYY-MM-DDTHH:MM:SSZ` in UTC, no fraction.

### 4.2 Tokens

`REASON_TOKENS`, in this order: `ok`, `kill_switch_active`, `recipient_suppressed`, `loop_repetition_detected`, `recipient_entropy_collapse`, `recipient_requires_approval`, `rate_ceiling_exceeded`, `agent_budget_exceeded`.

(AgentiSend's hosted service has two more, `trust_paused` and `brand_impersonation`; they never come from this library.)

Templates, byte for byte. `{x}` is a value, `plural(...)` is §4.1.

| Token | Outcome | Message |
|---|---|---|
| `ok` | allow | `No limit, loop or approval rule blocks this send.` |
| `kill_switch_active` | refuse | `Sending is paused by the kill switch, so nothing sends until a person resumes it.` |
| `recipient_suppressed` | refuse | `{recipient} is on the suppression list (rule: {rule}), so this guard never sends to it.` |
| `loop_repetition_detected` (repetition only) | refuse | `Blocked: {plural(matches, "near-identical email")} already went to {toLine} within {plural(minutes, "minute")}, which matches a retry or script loop; review the agent before sending more.` |
| `loop_repetition_detected` (both signals) | refuse | `Blocked: this key shows both a repetition loop ({plural(matches, "near-identical email")} to {toLine}) and collapsed recipient diversity (about {plural(effective, "effective recipient")}); review the agent before sending more.` |
| `recipient_entropy_collapse` | refuse | `Blocked: the last {plural(windowSize, "email")} went to about {plural(effective, "effective recipient")}, and this one goes to the same inbox again, which looks like a loop; mail to other recipients still sends.` |
| `recipient_requires_approval` (rule `recipient_list`) | hold_for_approval | `{recipient} matches the approval rule {rule}, so this email waits for a person to approve it.` |
| `recipient_requires_approval` (rule `custom`) | hold_for_approval | `Your approval rule matched this email, so it waits for a person to approve it.` |
| `recipient_requires_approval` (rule `new_recipient`) | hold_for_approval | `{recipient} has not received email from key "{key}" before, so this email waits for a person to approve it.` |
| `rate_ceiling_exceeded` | refuse | `Key "{key}" reached its ceiling of {plural(ceiling, "send")} per minute; wait {plural(retryAfter, "second")} and try again.` |
| `agent_budget_exceeded` | refuse | `Key "{key}" has used its {hourly\|daily\|monthly} budget of {plural(budget, "email")}; it resets at {instant(resetsAt)}.` |

`minutes = floor(windowMs / 60000 + 0.5)`; `effective = round3(2^entropyBits)`; `{recipient}` and `{rule}` are normalized (§3).

### 4.3 Evidence

Exact keys per decision (values numeric unless noted):

- **ok**: `key` (string); when loop mode is not `off`: `window_size`, `distinct_recipients`, `entropy_bits`, `effective_recipients`; when approved: `approved` (true); when a rate ceiling is set: `rate_used`, `rate_ceiling`; per configured budget: `hour_used`/`hour_budget`, `day_used`/`day_budget`, `month_used`/`month_budget` (values after this send's reservation).
- **kill_switch_active**: `paused_at`, `paused_by` (string), `pause_reason` (string).
- **recipient_suppressed**: `recipient`, `matched_rule` (strings).
- **loop refusals**: `signal_repetition`, `signal_entropy` (bools), `matching_sends_in_window`, `repetition_threshold`, `closest_subject_similarity`, `closest_body_similarity` (round3, null when no match), `window_size`, `distinct_recipients`, `entropy_bits` (round3), `effective_recipients` (round3), `perplexity_floor`, `candidate_recipient_share` (round3), `dominant_share_floor` (round3), `window_ms`.
- **recipient_requires_approval**: `rule` = `recipient_list` with `recipient`, `matched_rule`; or `custom` with `detail` (string or null); or `new_recipient` with `recipient` (the first unseen) and `new_recipients` (every unseen, comma-joined in recipient order).
- **rate_ceiling_exceeded**: `key`, `sends_in_window`, `ceiling_per_minute`, `retry_after_seconds`.
- **agent_budget_exceeded**: `key`, `period` (`hour`\|`day`\|`month`), `budget`, `used` (the counter's value, unchanged), `resets_at` (epoch ms).

## 5. Loop detection

Inputs: the key's logged sends with `at ≥ now − windowMs`, filtered again to `now − at ≤ windowMs`, oldest first (the **window**); the candidate (the send being checked, normalized as §3).

**Repetition.** A prior send is near-identical when its To line equals the candidate's AND subject similarity ≥ threshold AND body similarity ≥ threshold. `matches` counts them. The closest match is the one with the largest subject + body similarity (first one wins ties). Flagged when `mode ≠ off` and `matches ≥ maxIdenticalSends`.

**Entropy.** Count each recipient of each send in the window (a send to two people counts once for each). Iterate in first-seen order (oldest send first, recipients in order) so the floating-point sum is the same everywhere. `slots` = total count; `entropyBits = −Σ p·log2(p)` with `p = count/slots`; `perplexity = 2^entropyBits` (1 for an empty window). `trusted = windowSize ≥ minWindowForEntropy`. `collapsed = trusted and perplexity < floor`. `candidateShare` = the largest `count/slots` among the candidate's recipients (0 when slots is 0). `dominantShareFloor = 1/floor`. Flagged when `mode = full` and `collapsed` and `candidateShare ≥ dominantShareFloor`.

Repetition flagged → token `loop_repetition_detected` (message "both signals" when entropy is also flagged). Entropy alone → `recipient_entropy_collapse`.

## 6. Store

### 6.1 Contract

```
incrementWithCeiling(name, amount, ceiling|null, expiresAt|null) -> {ok, value}
decrement(name, amount)                      never below 0; missing counter is a no-op
getCounter(name) -> number                   missing counter is 0
windowAdd(name, member, at, windowMs, ceiling) -> {ok, count, oldestAt|null}
windowRemove(name, member)
appendSend(log, record, keepMs)
recentSends(log, since) -> [record]          at ≥ since, oldest first
getState(name) -> string|null
setState(name, string|null)                  null deletes
```

`incrementWithCeiling`: if `value + amount ≤ ceiling` (or ceiling is null) add and return `{ok: true, value: new}`; otherwise change nothing and return `{ok: false, value: current}`. `windowAdd`: drop members with `at − memberAt ≥ windowMs`; if the remaining count `< ceiling`, add the member and return `{ok: true, count: count+1}`; otherwise `{ok: false, count}`. `oldestAt` is the oldest remaining member's time (the new one when the window was empty). A send record is `{to_line, recipients, subject, body, at}` with the normalized fields of §3. The log MAY drop records older than `keepMs` before the newest and MUST keep at least `min(window contents, 10,000)` per key (`SEND_LOG_CAP`).

### 6.2 Atomicity

`incrementWithCeiling` and `windowAdd` MUST each be one atomic step: a conditional update (`UPDATE … SET value = value + $1 WHERE name = $2 AND value + $1 <= $3`), a Lua script, a mutex held across the read and the write. Never read-then-write across two round trips. Under N concurrent checks against a remaining budget of B, at most B are allowed. The other operations need not be atomic with each other: a crash between a reservation and a release can only over-refuse, never over-send.

### 6.3 Names

Store names are shared so processes in different languages can share one Redis or Postgres. `{ns}` is the namespace, default `agent-email-guard`:

| Name | Holds |
|---|---|
| `{ns}:kill` | kill state JSON `{"paused_at","paused_by","reason"}` |
| `{ns}:kill:last_resume` | JSON with exactly `{"paused_at", "paused_by", "reason", "resumed_at", "resumed_by"}` (snake_case, like every shared name) |
| `{ns}:{key}:log` | send log |
| `{ns}:{key}:seen:{address}` | counter, > 0 once a send to the address was recorded |
| `{ns}:{key}:rate` | rate window |
| `{ns}:{key}:budget:{hour\|day\|month}:{periodStartMs}` | budget counter, expires at period end |

Periods are UTC calendar periods: the hour starts at `floor(now/3600000)·3600000`, the day at `floor(now/86400000)·86400000`, the month on the first of the month at 00:00 UTC. A period's reset is the next period's start.

### 6.4 Backends and their data layout

Every implementation ships the in-memory store (default; one process, nothing shared). Redis and Postgres stores SHOULD be offered where the ecosystem has a standard client, as optional dependencies, never required by the core.

A Redis or Postgres store MUST use the layout below, so a Node agent and a Python worker on one database share one budget, one rate window, one send log and one kill switch.

**Send record JSON**: `{"to_line": string, "recipients": [string], "subject": string, "body": string, "at": integer}`. Readers ignore unknown fields.

**Redis** (all conditional steps in Lua):

| Kind | Type | Detail |
|---|---|---|
| counter | STRING | `INCRBY`; `PEXPIREAT expiresAt` when set; decrement never below 0 and keeps the TTL |
| window | ZSET | score = `at`, member = reservation id; prune `score <= at − windowMs`; `PEXPIRE windowMs` |
| log | ZSET | score = `at`, member = `<12 lowercase hex>|<send record JSON>`; decode from the first `|`; prune `score < at − keepMs`; trim to the newest 10,000 |
| state | STRING | `DEL` for null |

**Postgres** (default prefix `agent_email_guard`; all integers are `bigint`, times are epoch ms):

```sql
CREATE TABLE IF NOT EXISTS agent_email_guard_counters (name text PRIMARY KEY, value bigint NOT NULL, expires_at bigint NULL);
CREATE TABLE IF NOT EXISTS agent_email_guard_windows  (name text NOT NULL, member text NOT NULL, at bigint NOT NULL, PRIMARY KEY (name, member));
CREATE TABLE IF NOT EXISTS agent_email_guard_sends    (id bigserial PRIMARY KEY, log text NOT NULL, at bigint NOT NULL, record jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS agent_email_guard_sends_log_at ON agent_email_guard_sends (log, at);
CREATE TABLE IF NOT EXISTS agent_email_guard_state    (name text PRIMARY KEY, value text NOT NULL);
```

The budget step is one `INSERT … ON CONFLICT (name) DO UPDATE … WHERE value + amount <= ceiling RETURNING value`. The window step runs in a transaction under `pg_advisory_xact_lock(hashtext(name))`: delete expired members, count, insert when under the ceiling.

## 7. Check order

`check` runs these in order and returns the first block:

1. **Kill switch** — paused → refuse `kill_switch_active`.
2. **Suppression** — a recipient matches a `suppress` rule → refuse `recipient_suppressed`.
3. **Loop** — when `loop.mode ≠ off`: §5 → refuse `loop_repetition_detected` or `recipient_entropy_collapse`.
4. **Approval** (skipped when `approved`) — in this order: an `approval.recipients` match; `requireFor` truthy; `newRecipients` and any recipient whose seen-counter is 0 → hold `recipient_requires_approval`.
5. **Rate** — when `rate.perMinute` is set: `windowAdd(rate, member, now, 60000, perMinute)`; not ok → refuse `rate_ceiling_exceeded` with `retry_after_seconds = max(1, ceil((oldestAt + 60000 − now) / 1000))` (60 when `oldestAt` is null).
6. **Budgets** — hour, then day, then month, each configured one: `incrementWithCeiling(budget, 1, budget, periodEnd)`; not ok → give back what steps 5–6 reserved and refuse `agent_budget_exceeded`.
7. **Allow** `ok`, with the reservation.

Steps 1–4 reserve nothing, so a refusal or hold there leaves no state behind.

## 8. Hosted adapter (AgentiSend)

`agent-email-guard/agentisend` (and its ports) speaks to the AgentiSend API with an API key. The same rules then run server-side, shared by every process using any key on the account, and the agent cannot remove them. Endpoints it uses, all real:

| Adapter call | Endpoint |
|---|---|
| `check(send)` | `POST /emails/preflight` — runs every send gate, sends nothing |
| `send(send)` | `POST /emails` |
| `killSwitch.pause(reason)` | `POST /limits/keys/{keyId}/kill` with `{"reason"}` |
| `killSwitch.resume()` | not available to a key: `POST /limits/keys/{id}/resume` is a person's action in the console. The adapter throws. |
| `limits()` | `GET /limits/keys/{keyId}` |
| `setLimits({budget, period, perMinute})` | `PATCH /limits/keys/{keyId}` — a key may only lower its own limits |
| `approvals.list()` | `GET /agent-actions?state=pending` (approve/reject are a person's action in the console) |

Error mapping (the API's `error.code`): `kill_switch_active` → refuse `kill_switch_active`; `agent_budget_exceeded` → refuse `agent_budget_exceeded`; `rate_ceiling_exceeded` → refuse `rate_ceiling_exceeded`; `approval_required` (with `action_id` when the API queued the send) → hold `recipient_requires_approval`; `suppressed_recipient` → refuse `recipient_suppressed`. Messages and evidence on hosted decisions come from the API (`message`, `fix`, `code`, `action_id`), not from §4.2. Any other error is thrown as the adapter's API error, not turned into a decision.

## 9. Conformance vectors

`vectors/*.json` (schema: `vectors/vector.schema.json`). Each file has `cases`; each case has a `config` (snake_case keys, §2.1) and `steps`. A runner creates one guard per case with an injected clock and an in-memory store, then for each step sets the clock to `step.at` and:

| `op` | Do |
|---|---|
| `check` | `check(send, {approved})`; compare to `expect` |
| `send` | `check`; if allow, `record(send)`; compare the decision to `expect` |
| `record` | `record(send)`, `repeat` times (default 1), the clock advancing `every_ms` each time |
| `release` | `release(decision of step N)` where N is `step` (0-based) |
| `pause` | `killSwitch.pause(reason, by)`; when the step has no `by`, call `pause(reason)` so the default actor `agent-email-guard` applies |
| `resume` | `killSwitch.resume(by)`; compare `{resumed}` to `expect` |
| `read_state` | read the store's state `name` (§6.3) and compare `{state: JSON.parse(value) or null}` to `expect`, as JSON values |

A vector `config` may set `namespace`; without it the guard uses the default `agent-email-guard`, which `read_state` steps pin.

`approval.require_for` in a vector is `{subject_contains, detail}`: the runner's callback returns `detail` (or `true` when `detail` is null) when the send's subject contains `subject_contains`, else `false`.

Compare `outcome`, `reason` and `message` byte for byte, and `evidence` as a map: same keys, strings and bools equal, numbers numerically equal (`1` equals `1.0`). Ignore `reservation`. An implementation conforms when every step of every case matches.

The vectors are generated by running the Node package (`node/scripts/gen-vectors.ts`), whose loop steps are cross-checked against AgentiSend's production guard on every generation. Never edit an `expect` by hand.

Concurrency (§6.2) cannot be expressed as a sequence; each implementation MUST ship its own race test: 200 concurrent checks against a budget of 50 allow exactly 50.

## 10. Versioning

The spec version, the vectors and every package version move together on minor versions: 0.1.x of any port passes the 0.1 vectors. A template or token change is a minor version bump in every language at once.
