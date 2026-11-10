# Mastra

Targeted `@mastra/core` 1.82.0 on 2026-11-09. Docs: [createTool()](https://mastra.ai/reference/tools/create-tool) and [human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop).

`guardedEmailTool` returns a tool from `createTool`. `execute` is `(input, context)`. A refusal is the tool result text. `hold_for_approval` calls `context.agent.suspend` with the reason, the message, and the approval id. A later execution with `resumeData.approved === true` sends.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. The example uses an in-memory stub and does not open a socket.

Wrappers take a guard from `createGuard()` in the published `agent-email-guard` package (0.1.0), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store. A resume with `approved: true` sends through `check(send, { approved: true })`: the approval rules are skipped and the budgets still apply.

```ts
import { guardedEmailTool } from "./src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
```

Run the stub: `npm run example` from this directory. `npm test` checks the suspend payload.
