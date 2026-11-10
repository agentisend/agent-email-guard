# OpenAI Agents SDK (JavaScript)

Targeted `@openai/agents` 0.21.0 on 2026-11-09. Docs: [tool guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/).

`guardedEmailTool` returns a function tool with one input guardrail named `agent-email-guard`. The SDK runs that guardrail before `invoke`. A refusal or a hold comes back from `runToolInputGuardrails` as `{ type: "reject", message }`. The message starts with the outcome and the reason token. The tool body does not run.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. Pass any `send` function. This example uses an in-memory stub and does not open a socket.

The guardrail is the one `agent-email-guard` 0.1.0 ships: `emailInputGuardrail` from `agent-email-guard/openai-agents`. This folder pins it against `@openai/agents` 0.21.0 with a real guard. It records an allowed call when the guardrail passes, so a send that then fails still counts. The message the model reads is `refuse (agent_budget_exceeded): ...`.

```ts
import { Agent } from "@openai/agents";
import { guardedEmailTool } from "./src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
const agent = new Agent({
  name: "mail",
  instructions: "Send the email the person asked for.",
  tools: [sendEmail],
});
```

Run the stub: `npm run example` from this directory. `npm test` runs the guardrail checks.
