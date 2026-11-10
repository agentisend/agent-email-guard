import re
from importlib.metadata import version
from typing import TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from adapter import Transport, make_test_guard
from guarded_email import guarded_email_tool

PAYLOAD = {"to": "user@example.com", "subject": "Receipt", "text": "Paid."}


class State(TypedDict):
    result: str


def _graph(tool, payload=PAYLOAD):
    def node(_state: State) -> State:
        return {"result": str(tool.invoke(payload))}

    graph = StateGraph(State)
    graph.add_node("send", node)
    graph.add_edge(START, "send")
    graph.add_edge("send", END)
    return graph.compile(checkpointer=InMemorySaver())


def test_targeted_versions() -> None:
    assert version("langchain") == "1.4.9"
    assert version("langgraph") == "1.2.20"
    assert version("agent-email-guard") == "0.1.0"


def test_send_over_the_daily_budget_is_tool_text() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(budgets={"per_day": 1}), transport.send, key="agent-1")
    assert tool.invoke(PAYLOAD) == "Sent stub-1"
    text = tool.invoke({**PAYLOAD, "text": "Second receipt."})
    assert re.match(r'^Key "agent-1" has used its daily budget of 1 email; .*\[agent_budget_exceeded\]$', text)
    assert len(transport.sent) == 1


def test_hold_interrupts_and_sends_only_after_approve() -> None:
    transport = Transport()
    guard = make_test_guard(approval={"recipients": ["@example.com"]})
    app = _graph(guarded_email_tool(guard, transport.send))
    config = {"configurable": {"thread_id": "receipt-1"}}
    paused = app.invoke({"result": ""}, config)
    assert paused["__interrupt__"][0].value["reason"] == "recipient_requires_approval"
    assert transport.sent == []
    resumed = app.invoke(Command(resume={"action": "approve"}), config)
    assert resumed["result"] == "Sent stub-1"
    assert len(transport.sent) == 1


def test_approved_send_still_counts_against_the_budget() -> None:
    transport = Transport()
    guard = make_test_guard(budgets={"per_day": 1}, approval={"recipients": ["vip@example.com"]})
    tool = guarded_email_tool(guard, transport.send)
    assert tool.invoke(PAYLOAD) == "Sent stub-1"
    app = _graph(tool, {**PAYLOAD, "to": "vip@example.com"})
    config = {"configurable": {"thread_id": "receipt-3"}}
    app.invoke({"result": ""}, config)
    resumed = app.invoke(Command(resume={"action": "approve"}), config)
    assert resumed["result"].endswith("[agent_budget_exceeded]")
    assert len(transport.sent) == 1


def test_declined_resume_does_not_send() -> None:
    transport = Transport()
    guard = make_test_guard(approval={"recipients": ["@example.com"]})
    app = _graph(guarded_email_tool(guard, transport.send))
    config = {"configurable": {"thread_id": "receipt-2"}}
    app.invoke({"result": ""}, config)
    resumed = app.invoke(Command(resume={"action": "reject"}), config)
    assert resumed["result"].startswith("Approval required.")
    assert resumed["result"].endswith("[recipient_requires_approval]")
    assert transport.sent == []
