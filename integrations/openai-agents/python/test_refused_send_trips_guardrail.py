import asyncio
import re
from importlib.metadata import version

import pytest

from adapter import Transport, make_test_guard
from guarded_email import apply_email_guardrail, guarded_email_tool

PAYLOAD = {"to": "user@example.com", "subject": "Receipt", "text": "Paid."}


def run(tool, payload=PAYLOAD) -> str:
    return asyncio.run(apply_email_guardrail(tool, payload))


def test_targeted_versions() -> None:
    assert version("openai-agents") == "0.24.0"
    assert version("agent-email-guard") == "0.1.0"


def test_send_over_the_daily_budget_trips_the_tool_input_guardrail() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(budgets={"per_day": 1}), transport.send, key="agent-1")
    assert tool.tool_input_guardrails[0].name == "agent-email-guard"
    assert run(tool) == "Sent stub-1"
    text = run(tool, {**PAYLOAD, "text": "Second receipt."})
    assert re.match(r'^refuse \(agent_budget_exceeded\): Key "agent-1" has used its daily budget of 1 email;', text)
    assert len(transport.sent) == 1


def test_hold_is_a_guardrail_rejection() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(approval={"recipients": ["@example.com"]}), transport.send)
    assert run(tool).startswith("hold_for_approval (recipient_requires_approval): ")
    assert transport.sent == []


def test_fourth_identical_send_is_a_loop() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(), transport.send)
    for i in range(3):
        assert run(tool) == f"Sent stub-{i + 1}"
    assert run(tool).startswith("refuse (loop_repetition_detected): ")
    assert len(transport.sent) == 3


def test_transport_failure_reaches_the_caller() -> None:
    transport = Transport()
    transport.fail_next()
    tool = guarded_email_tool(make_test_guard(), transport.send)
    with pytest.raises(Exception, match="stub transport refused"):
        run(tool)
