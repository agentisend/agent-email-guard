"""A send-email tool for an LLM agent, guarded (LangChain or the OpenAI Agents SDK).

The tool returns the guard's sentence instead of raising, so the model reads
why a send was refused or held and can tell the user, rather than retrying
in a loop. Register the same function with either framework:

    pip install agent-email-guard langchain-core          # LangChain
    pip install agent-email-guard openai-agents           # OpenAI Agents SDK
"""

from agent_email_guard import ApprovalRequired, Guard, GuardRefused

guard = Guard(
    budgets={"per_hour": 20, "per_day": 100},
    rate={"per_minute": 5},
    approval={"new_recipients": True},
)

#: Held sends, keyed by the recipient, for a person to approve later.
held = {}


def make_tool(provider_send, guard=guard):
    guarded = guard.wrap(provider_send)

    def send_email(to: str, subject: str, body: str) -> str:
        """Send one email. Returns what happened, in a sentence."""
        try:
            result = guarded({"to": to, "subject": subject, "text": body})
            return f"Sent ({result})."
        except GuardRefused as stop:
            return f"Not sent: {stop.decision.message}"
        except ApprovalRequired as wait:
            held[to] = wait
            return f"Waiting for approval: {wait.decision.message}"

    return send_email


def as_langchain_tool(fn):
    from langchain_core.tools import StructuredTool

    return StructuredTool.from_function(fn, name="send_email", description=fn.__doc__)


def as_openai_agents_tool(fn):
    from agents import function_tool

    return function_tool(fn)


if __name__ == "__main__":
    from agentisend import AgentiSend

    client = AgentiSend()
    tool_fn = make_tool(lambda p: client.send_email({"from": "agent@acme.dev", **p})["id"])
    print(tool_fn("someone@example.com", "Hello", "First message."))
