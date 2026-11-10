# LangChain and LangGraph (JavaScript)

Targeted `langchain` 1.6.3, `@langchain/core` 1.3.5, and `@langchain/langgraph` 1.7.2 on 2026-11-09. Docs: [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

`guardedEmailTool` returns a LangChain tool. A refusal is the tool result text. `hold_for_approval` calls `interrupt()` inside the tool. The graph needs a checkpointer and a `thread_id`. Resume with `new Command({ resume: { action: "approve" } })`. The node runs from the start again, so `decide` must return `hold_for_approval` for that send until it is recorded.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. The example uses an in-memory stub and does not open a socket.

Wrappers take a guard from `createGuard()` in the published `agent-email-guard` package (0.1.0), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store. An approve sends through `check(send, { approved: true })`: the approval rules are skipped and the budgets still apply.

```ts
import { guardedEmailTool } from "./src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
```

Run the stub: `npm run example` from this directory. `npm test` pauses a graph on a hold and sends only after approve.
