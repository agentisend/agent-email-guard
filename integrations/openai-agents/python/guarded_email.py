"""OpenAI Agents SDK tool with an agent-email-guard input guardrail.

Targeted openai-agents 0.24.0. function_tool(..., tool_input_guardrails=...)
is the native slot. The runner calls those guardrails before on_invoke_tool.
A refusal or a hold returns reject_content, so the tool body does not run, and
the model reads "refuse (agent_budget_exceeded): ...", the same text as the
Node package's agent-email-guard/openai-agents guardrail. An allowed call is
recorded when the guardrail passes, so a send that then fails still counts.
"""

from __future__ import annotations

import json
from typing import Any

from agents import Agent, ToolGuardrailFunctionOutput, function_tool, tool_input_guardrail
from agents.run_internal.tool_execution import _execute_tool_input_guardrails
from agents.tool import FunctionTool
from agents.tool_context import ToolContext

from adapter import EmailGuard, Send, to_email_send


def guarded_email_tool(guard: EmailGuard, send: Send, key: str | None = None) -> FunctionTool:
    @tool_input_guardrail(name="agent-email-guard")
    def check(data: Any) -> ToolGuardrailFunctionOutput:
        payload = json.loads(data.context.tool_arguments or "{}")
        email = to_email_send(payload, key)
        decision = guard.check(email)
        if decision.outcome != "allow":
            return ToolGuardrailFunctionOutput.reject_content(
                f"{decision.outcome} ({decision.reason}): {decision.message}"
            )
        guard.record(email)
        return ToolGuardrailFunctionOutput.allow()

    @function_tool(
        name_override="send_email",
        description_override=(
            "Send one email. The agent-email-guard tool input guardrail checks the "
            "budgets, the rate ceiling, repeats and approval rules before the send."
        ),
        tool_input_guardrails=[check],
        # A transport failure must reach the caller. The default handler turns it into a string.
        failure_error_function=None,
    )
    def send_email(to: str, subject: str, text: str = "") -> str:
        """Send one email after the agent-email-guard tool input guardrail allows it."""
        result = send(to_email_send({"to": to, "subject": subject, "text": text}, key))
        return f"Sent {result['id']}"

    return send_email


async def apply_email_guardrail(email_tool: FunctionTool, payload: dict[str, object]) -> str:
    """Run the SDK's tool input guardrail loop, then invoke only when it allows."""
    agent = Agent(name="mail", instructions="Send the email the person asked for.")
    raw = json.dumps(payload)
    context = ToolContext(
        context=None,
        tool_name=email_tool.name,
        tool_call_id="call-1",
        tool_arguments=raw,
    )
    message = await _execute_tool_input_guardrails(
        func_tool=email_tool,
        tool_context=context,
        agent=agent,
        tool_input_guardrail_results=[],
    )
    if message is not None:
        return message
    sent = await email_tool.on_invoke_tool(context, raw)
    return str(sent)
