"""Every example runs against a stub provider: no network, no SDK installed."""

import sys
from email.message import EmailMessage
from pathlib import Path

import pytest

from agent_email_guard import Guard, GuardRefused

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))

import agent_tool  # noqa: E402
import agentisend_sdk  # noqa: E402
import boto3_ses  # noqa: E402
import resend_sdk  # noqa: E402
import smtp_stdlib  # noqa: E402


def tight(clock, **extra):
    return Guard(budgets={"per_day": 2}, clock=clock, **extra)


def test_agentisend_sdk_example(clock):
    class Client:
        sent = []

        def send_email(self, payload, idempotency=None):
            self.sent.append(payload)
            return {"id": f"msg_{len(self.sent)}"}

    send = agentisend_sdk.build_send(Client(), tight(clock))
    assert send({"to": "a@x.com", "subject": "s", "text": "1"}) == {"id": "msg_1"}
    send({"to": "b@x.com", "subject": "s", "text": "2"})
    with pytest.raises(GuardRefused):
        send({"to": "c@x.com", "subject": "s", "text": "3"})


def test_resend_example(clock):
    class Emails:
        @staticmethod
        def send(params):
            return {"id": "re_1"}

    send = resend_sdk.build_send(Emails, Guard(approval={"recipients": ["@bigcustomer.com"]}, clock=clock))
    assert send({"from": "a@acme.dev", "to": ["x@y.com"], "subject": "Welcome", "html": "<p>Hi</p>"}) == {"id": "re_1"}
    from agent_email_guard import ApprovalRequired

    with pytest.raises(ApprovalRequired) as held:
        send({"from": "a@acme.dev", "to": ["cfo@bigcustomer.com"], "subject": "Q3", "html": "<p>x</p>"})
    assert held.value.approve() == {"id": "re_1"}


def test_boto3_ses_example(clock):
    calls = []

    class SES:
        def send_email(self, **kwargs):
            calls.append(kwargs)
            return {"MessageId": "ses-1"}

    send = boto3_ses.build_send(SES(), Guard(suppress=["@blocked.example"], clock=clock))
    kwargs = dict(
        Source="b@acme.dev",
        Destination={"ToAddresses": ["c@x.com"], "BccAddresses": ["audit@blocked.example"]},
        Message={"Subject": {"Data": "Invoice"}, "Body": {"Text": {"Data": "Attached."}}},
    )
    with pytest.raises(GuardRefused) as stop:
        send(**kwargs)
    assert stop.value.reason == "recipient_suppressed" and calls == []
    kwargs["Destination"] = {"ToAddresses": ["c@x.com"]}
    assert send(**kwargs) == {"MessageId": "ses-1"}


def test_smtp_example(clock):
    delivered = []

    class FakeSMTP:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def send_message(self, msg):
            delivered.append(msg["To"])

    guard = Guard(clock=clock)
    send = smtp_stdlib.build_send(FakeSMTP, guard)
    for _ in range(3):
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = "alerts@acme.dev", "oncall@acme.dev", "Disk at 91%"
        msg.set_content("db-1 crossed 90% disk.")
        send(msg)
    with pytest.raises(GuardRefused) as stop:
        send(msg)
    assert stop.value.reason == "loop_repetition_detected"
    assert delivered == ["oncall@acme.dev"] * 3


def test_agent_tool_returns_sentences_not_exceptions(clock):
    guard = Guard(budgets={"per_hour": 1}, approval={"new_recipients": True}, clock=clock)
    tool = agent_tool.make_tool(lambda payload: "msg_1", guard)
    first = tool("new@person.example", "Hello", "Hi there.")
    assert first.startswith("Waiting for approval: new@person.example has not received email")
    assert agent_tool.held["new@person.example"].approve() == "msg_1"
    assert tool("new@person.example", "Again", "Second.").startswith('Not sent: Key "default" has used its hourly budget of 1 email')
