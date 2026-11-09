# agent-email-guard

Blast-radius control for agents that send email: per-key budgets and rate ceilings, loop detection, a kill switch and approval holds. Zero runtime dependencies; ESM and CommonJS; Node 18+.

```bash
npm install agent-email-guard
```

```ts
import { createGuard, GuardRefused, ApprovalRequired } from 'agent-email-guard';

const guard = createGuard({
  key: 'support-agent',
  budgets: { perHour: 50, perDay: 300, perMonth: 5000 },
  rate: { perMinute: 10 },
  loop: { mode: 'full' },
  approval: { recipients: ['@bigcustomer.com'], newRecipients: false, requireFor: (s) => /refund/i.test(s.subject ?? '') && 'Refunds need a person.' },
  suppress: ['@competitor.example'],
});

const send = guard.wrap((mail) => transporter.sendMail(mail));

try {
  await send({ from: 'agent@yourapp.com', to: 'ana@example.com', subject: 'Your ticket', text: 'Fixed in 4.2.1.' });
} catch (err) {
  if (err instanceof ApprovalRequired) await queueForAPerson(err);  // later: await err.approve()
  else if (err instanceof GuardRefused) log(err.reason, err.message);
  else throw err;                                                    // the provider's own error
}
```

The full contract, shared with the Python, PHP and Go packages, is in [spec/SPEC.md](../spec/SPEC.md).

## API

### `createGuard(config) → Guard`

| Option | Default | |
|---|---|---|
| `key` | `"default"` | Key a send counts against when the send has no `key`. |
| `budgets.perHour / perDay / perMonth` | none | Emails per key per UTC hour, day, month. |
| `rate.perMinute` | none | Emails per key per sliding minute. |
| `loop` | `LOOP_DEFAULTS` | `mode` (`full`, `repetition_only`, `off`), `windowMs` 3,600,000, `similarityThreshold` 0.85, `maxIdenticalSends` 3, `minWindowForEntropy` 20, `recipientPerplexityFloor` 3. |
| `approval.recipients` | `[]` | Addresses or `@domain`s that wait for a person. |
| `approval.newRecipients` | `false` | Hold a send to any address this key has never had a recorded send to. |
| `approval.requireFor` | none | `(send) => boolean \| string`, may be async. A string is kept as `evidence.detail`. |
| `suppress` | `[]` | Addresses or `@domain`s never sent to. |
| `store` | `MemoryStore` | `RedisStore`, `PostgresStore`, or your own `GuardStore`. |
| `clock` | `Date.now` | Inject for tests. |
| `namespace` | `"agent-email-guard"` | Prefix for store names. |

A send is `{ key?, from?, to, cc?, bcc?, subject?, text?, html? }`. Addresses may be strings (`"Ana <ana@example.com>"`, comma-separated), `{ address }` objects, or arrays.

### `guard.check(send, { approved? }) → Promise<Decision>`

Runs, in order: kill switch, suppression, loop detection, approval rules, rate ceiling, budgets. Returns `{ outcome, reason, message, evidence, reservation? }`. Only an `allow` reserves anything. `approved: true` skips the approval rules and nothing else.

### `guard.record(send)` / `guard.release(decision)`

After the provider accepted the send, `record` feeds loop detection and the new-recipient memory. If the provider failed, `release` gives back the budget and rate slot. `wrap` does both for you.

### `guard.wrap(fn, { toGuardSend? })`

Returns a function with `fn`'s signature that checks, calls `fn`, records or releases, and throws `GuardRefused` or `ApprovalRequired` (both carry `.decision`, `.reason`, `.message`). `toGuardSend(...args)` maps provider-specific arguments; the default reads the first argument.

### `guard.killSwitch`

`pause(reason, by?)` stops every send through this guard and every guard sharing its store. `resume(by)` returns `true`, or `false` when nothing was paused. There is no timer.

## Reason tokens

| Token | Outcome |
|---|---|
| `ok` | allow |
| `kill_switch_active` | refuse |
| `recipient_suppressed` | refuse |
| `loop_repetition_detected` | refuse |
| `recipient_entropy_collapse` | refuse |
| `recipient_requires_approval` | hold_for_approval |
| `rate_ceiling_exceeded` | refuse |
| `agent_budget_exceeded` | refuse |

## Policy file and CLI

`agent-email-guard.json` holds the same settings in snake_case, shared with the Python, PHP and Go packages:

```ts
import { createGuard } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';
const guard = createGuard({ ...loadPolicy(), store });   // ./agent-email-guard.json; unknown keys are an error
```

```bash
npx agent-email-guard validate [agent-email-guard.json]
npx agent-email-guard check [--policy file] [send.json]   # stdin without a file; exit 0 allow, 2 hold, 3 refuse
```

```bash
npx agent-email-guard hook install                        # Claude Code PreToolUse hook (agent-email-guard-mcp)
npx agent-email-guard mcp --wrap "<upstream MCP command>" # guard in front of any email MCP server
npx agent-email-guard test <agent.ts>                     # red-team harness (agent-email-guard-test)
```

Those three forward to `agent-email-guard-mcp` and `agent-email-guard-test`; see `mcp/` and `redteam/`.

## nodemailer plugin

```ts
import { nodemailerGuard } from 'agent-email-guard/nodemailer';
transporter.use('compile', nodemailerGuard(loadPolicy()));
// sendMail now rejects with GuardRefused / ApprovalRequired. After a person approves,
// send the same message again with guardApproved: true.
```

The plugin records a message when it passes, before SMTP answers; `guard.wrap(transporter.sendMail)` gives the budget back when the send fails.

## OpenAI Agents SDK

```ts
import { tool } from '@openai/agents';
import { emailInputGuardrail } from 'agent-email-guard/openai-agents';
const sendEmail = tool({ name: 'send_email', parameters, execute, inputGuardrails: [emailInputGuardrail(guard)] });
```

A refusal or hold becomes `rejectContent`: the tool does not run and the model reads `refuse (rate_ceiling_exceeded): Key "assistant" reached its ceiling of 5 sends per minute; wait 41 seconds and try again.`

## Sharing limits across processes

The default store lives in one process. To share budgets, the rate window, the loop log and the kill switch across processes (and across the Python, PHP and Go packages, which use the same layout):

```ts
import Redis from 'ioredis';
import { RedisStore } from 'agent-email-guard/redis';
const guard = createGuard({ store: new RedisStore(new Redis(process.env.REDIS_URL)), budgets: { perDay: 500 } });
```

```ts
import pg from 'pg';
import { PostgresStore } from 'agent-email-guard/postgres';
const store = new PostgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
await store.migrate(); // or copy postgresSchema() into your migrations
const guard = createGuard({ store, budgets: { perDay: 500 } });
```

`ioredis` and `pg` are optional peer dependencies. A node-redis v4 client works through a small adapter: `{ eval: (s, n, ...a) => client.eval(s, { keys: a.slice(0, n).map(String), arguments: a.slice(n).map(String) }), get: (k) => client.get(k), set: (k, v) => client.set(k, v), del: (...k) => client.del(k), zrangebyscore: (k, a, b) => client.zRangeByScore(k, a, b) }`.

Budget and rate steps are each one atomic operation (a Lua script, or a conditional upsert), so 200 concurrent checks against a budget of 50 admit exactly 50.

## Advisory, or enforced

This package runs in your agent's process, so code the agent controls can remove it. [AgentiSend](https://agentisend.com) enforces the same rules on the API key, where the agent cannot. Use the hosted adapter to get the same decision shape:

```ts
import { createHostedGuard } from 'agent-email-guard/agentisend';
const guard = createHostedGuard({ apiKey: process.env.AGENTISEND_API_KEY, keyId: process.env.AGENTISEND_KEY_ID });
await guard.check(email);                // POST /emails/preflight, sends nothing
await guard.send(email);                 // POST /emails
await guard.setLimits({ budget: 200, period: 'daily', perMinute: 10 });  // lower only
await guard.killSwitch.pause('Looping.'); // resuming is a person's action in the console
```

## Examples

[nodemailer](examples/nodemailer.ts) · [Amazon SES v3](examples/ses.ts) · [Resend](examples/resend.ts) · [AgentiSend](examples/agentisend.ts) · [Vercel AI SDK tool](examples/vercel-ai-tool.ts)

## License

MIT, copyright AgentiSend.
