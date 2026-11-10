# Vercel AI SDK

Targeted `ai` 7.0.166 on 2026-11-09. Docs: [tool()](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool). The tool uses `inputSchema` and `execute`.

`guardedEmailTool({ guard, send })` returns that tool. A refusal or a hold is the tool result text, with the reason token in brackets, so the model sees why. The stub transport is not called.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. This example uses an in-memory stub and does not open a socket.

Wrappers take a guard from `createGuard()` in the published `agent-email-guard` package (0.1.0), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store.

```ts
import { guardedEmailTool } from "./src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
```

Run the stub: `npm run example` from this directory. `npm test` checks the tool result.
