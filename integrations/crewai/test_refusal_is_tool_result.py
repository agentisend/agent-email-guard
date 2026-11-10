import re
from importlib.metadata import version

import pytest

from adapter import Transport, make_test_guard
from guarded_email import guarded_email_tool

PAYLOAD = {"to": "user@example.com", "subject": "Receipt", "text": "Paid."}


def test_targeted_versions() -> None:
    assert version("crewai") == "1.15.39"
    assert version("agent-email-guard") == "0.1.0"


def test_send_over_the_daily_budget_is_the_tool_result() -> None:
    guard = make_test_guard(budgets={"per_day": 1})
    transport = Transport()
    tool = guarded_email_tool(guard, transport.send, key="agent-1")
    assert tool.name == "send_email"
    assert tool.run(**PAYLOAD) == "Sent stub-1"
    text = tool.run(**{**PAYLOAD, "text": "Second receipt."})
    assert re.match(r'^Key "agent-1" has used its daily budget of 1 email; .*\[agent_budget_exceeded\]$', text)
    assert len(transport.sent) == 1


def test_hold_is_the_tool_result_and_does_not_send() -> None:
    guard = make_test_guard(approval={"recipients": ["@example.com"]})
    transport = Transport()
    text = guarded_email_tool(guard, transport.send).run(**PAYLOAD)
    assert text.startswith("Approval required. ")
    assert text.endswith("[recipient_requires_approval]")
    assert transport.sent == []


def test_fourth_identical_send_is_a_loop() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(), transport.send)
    for i in range(3):
        assert tool.run(**PAYLOAD) == f"Sent stub-{i + 1}"
    assert tool.run(**PAYLOAD).endswith("[loop_repetition_detected]")
    assert len(transport.sent) == 3


def test_transport_failure_releases_the_budget() -> None:
    guard = make_test_guard(budgets={"per_day": 1})
    transport = Transport()
    transport.fail_next()
    tool = guarded_email_tool(guard, transport.send)
    with pytest.raises(RuntimeError, match="stub transport refused"):
        tool.run(**PAYLOAD)
    assert tool.run(**PAYLOAD) == "Sent stub-1"
