# OpenAI Agents SDK (Python)

Targeted `openai-agents` 0.24.0 on 2026-11-09. Docs: [tool guardrails](https://openai.github.io/openai-agents-python/guardrails/).

`guarded_email_tool` returns a `function_tool` with one `tool_input_guardrails` entry named `agent-email-guard`. The SDK runs that guardrail before `on_invoke_tool`. A refusal or a hold is `reject_content`. The tool body does not run. The message includes the reason token in brackets.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. Pass any `send` function. The example uses an in-memory stub and does not open a socket.

Wrappers take an `agent_email_guard.Guard` from the published `agent-email-guard` package (0.1.0 on PyPI), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store. The guardrail records an allowed call when it passes, the same as the Node package's `agent-email-guard/openai-agents` guardrail, so a send that then fails still counts.

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

Run the stub from this directory: `python example_stub.py`. `pytest` runs the guardrail checks.
