# LangChain and LangGraph (Python)

Targeted `langchain` 1.4.9 and `langgraph` 1.2.20 on 2026-11-09. Docs: [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

`guarded_email_tool` returns a LangChain tool. A refusal is the tool result text. `hold_for_approval` calls `interrupt()`. The graph needs a checkpointer and a `thread_id`. Resume with `Command(resume={"action": "approve"})`. The node runs from the start again, so `decide` must return `hold_for_approval` for that send until it is recorded.

agent-email-guard is blast-radius control for agents that send email: at most N sends a day, M an hour, no repeat loop, and no send that matches an approval rule until a person approves it. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with AgentiSend, nodemailer, SES, Resend, Postmark, and SMTP. The example uses an in-memory stub and does not open a socket.

Wrappers take an `agent_email_guard.Guard` from the published `agent-email-guard` package (0.1.0 on PyPI), or anything with its `check`, `record` and `release`. The tests and the example use a real guard with the in-memory store. An approve sends through `check(send, approved=True)`: the approval rules are skipped and the budgets still apply.

```python
from guarded_email import guarded_email_tool

send_email = guarded_email_tool(guard, send)
```

Run the stub from this directory: `python example_stub.py`. `pytest` pauses a graph on a hold and sends only after approve.
