# CrewAI

Targeted `crewai` 1.15.39 on 2026-11-09. Docs: [create custom tools](https://docs.crewai.com/edge/en/learn/create-custom-tools). The tool subclasses `BaseTool` and sets `args_schema`.

`guarded_email_tool` returns that tool. A refusal or a hold is the string from `_run`, and the send callable is not called. CrewAI has no graph interrupt, so a hold is text the agent can read, including the approval id.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. The example uses an in-memory stub and does not open a socket.

Wrappers take an `agent_email_guard.Guard` from the published `agent-email-guard` package (0.1.0 on PyPI), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store.

```python
from guarded_email import guarded_email_tool

send_email = guarded_email_tool(guard, send)
```

Run the stub from this directory: `python example_stub.py`. `pytest` checks the tool result.
