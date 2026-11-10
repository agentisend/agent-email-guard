# agent-email-guard inside agent frameworks

The npm and PyPI name is `agent-email-guard`. The Python import is `agent_email_guard`. The in-repo directory stays `oss/agent-guard/`.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. Every example below uses an in-memory stub and does not open a socket. Each JavaScript wrapper takes a guard from `createGuard()` in the published `agent-email-guard` package; `adapter/decisions.ts` holds the shared check → send → record / release step. Each Python integration has an identical `adapter.py` over `agent_email_guard.Guard`. Tests run against a real guard with the in-memory store, not a stub guard.

A hold that a person approves is sent with `check(send, { approved: true })` (Python `approved=True`): the approval rules are skipped and the budgets, the rate ceiling and loop detection still apply.

| Framework | Install | 10-line example |
|---|---|---|
| Vercel AI SDK | `ai` 7.0.166, code in `ai-sdk/` | `ai-sdk/examples/stub-send.ts` |
| OpenAI Agents SDK, JavaScript | `@openai/agents` 0.21.0, code in `openai-agents/js/` | `openai-agents/js/examples/stub-send.ts` |
| OpenAI Agents SDK, Python | `openai-agents` 0.24.0, code in `openai-agents/python/` | `openai-agents/python/example_stub.py` |
| LangChain / LangGraph, JavaScript | `@langchain/langgraph` 1.7.2, code in `langchain/js/` | `langchain/js/examples/stub-send.ts` |
| LangChain / LangGraph, Python | `langgraph` 1.2.20, code in `langchain/python/` | `langchain/python/example_stub.py` |
| Mastra | `@mastra/core` 1.82.0, code in `mastra/` | `mastra/examples/stub-send.ts` |
| CrewAI | `crewai` 1.15.39, code in `crewai/` | `crewai/example_stub.py` |
| MCP servers | `agent-email-guard-mcp`, built in `oss/agent-guard/mcp` | Do not duplicate. See that directory. |

In every example, `guard` is the published package's guard and `send` is your provider call:

```ts
import { createGuard } from "agent-email-guard";
import { loadPolicy } from "agent-email-guard/policy";
const guard = createGuard(loadPolicy()); // ./agent-email-guard.json
```

```python
from agent_email_guard import Guard
guard = Guard.from_policy()  # ./agent-email-guard.json
```

Vercel AI SDK, 10 lines:

```ts
import { guardedEmailTool } from "./ai-sdk/src/index.ts";

const sendEmail = guardedEmailTool({
  guard,
  send: async () => ({ id: "stub-1" }),
});
const text = await sendEmail.execute!(
  { to: "user@example.com", subject: "Receipt", text: "Paid." },
  { toolCallId: "call-1", messages: [] },
);
```

OpenAI Agents SDK, JavaScript, 10 lines:

```ts
import { Agent } from "@openai/agents";
import { guardedEmailTool } from "./openai-agents/js/src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
const agent = new Agent({
  name: "mail",
  instructions: "Send the email the person asked for.",
  tools: [sendEmail],
});
```

The SDK runs the shipped `emailInputGuardrail` (`agent-email-guard/openai-agents`) before `invoke`. A refusal returns `{ type: "reject", message }` from `runToolInputGuardrails`.

OpenAI Agents SDK, Python, 10 lines:

```python
from agents import Agent
from guarded_email import guarded_email_tool

send_email = guarded_email_tool(guard, send)
agent = Agent(
    name="mail",
    instructions="Send the email the person asked for.",
    tools=[send_email],
)
```

LangChain, JavaScript, 10 lines:

```ts
import { guardedEmailTool } from "./langchain/js/src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
const text = await sendEmail.invoke({
  to: "user@example.com",
  subject: "Receipt",
  text: "Paid.",
});
```

`hold_for_approval` calls `interrupt()` from `@langchain/langgraph`. Resume with `new Command({ resume: { action: "approve" } })`.

LangChain, Python, 10 lines:

```python
from guarded_email import guarded_email_tool

send_email = guarded_email_tool(guard, send)
print(send_email.invoke({
    "to": "user@example.com",
    "subject": "Receipt",
    "text": "Paid.",
}))
```

`hold_for_approval` calls `interrupt()` from `langgraph.types`. Resume with `Command(resume={"action": "approve"})`.

Mastra, 10 lines:

```ts
import { guardedEmailTool } from "./mastra/src/index.ts";

const sendEmail = guardedEmailTool({ guard, send });
const text = await sendEmail.execute!(
  { to: "user@example.com", subject: "Receipt", text: "Paid." },
  {},
);
```

`hold_for_approval` calls `context.agent.suspend`.

CrewAI, 10 lines:

```python
from guarded_email import guarded_email_tool

send_email = guarded_email_tool(guard, send)
print(send_email.run(
    to="user@example.com",
    subject="Receipt",
    text="Paid.",
))
```

MCP: the proxy package is `agent-email-guard-mcp`, directory `oss/agent-guard/mcp`. This folder does not wrap it again.
