"""The hosted adapter against a stub transport that answers in AgentiSend's wire shape."""

import json

import pytest

from agent_email_guard import ApprovalRequired, GuardRefused, is_valid_decision
from agent_email_guard.agentisend import AgentiSendAPIError, AgentiSendGuard, decision_from_error

KEY_ID = "0b6a1c1e-2f6e-4a39-9a7e-2d3f1c6c7a10"


class Stub:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, json.loads(body) if body else None))
        status, payload = self.answers.pop(0)
        return status, {}, json.dumps(payload).encode() if payload is not None else b""


def err(status, code, message, **extra):
    error = {"code": code, "message": message, "fix": "Do the documented thing.", "docs_url": "https://agentisend.com/x", **extra}
    return status, {"statusCode": status, "name": code, "message": message, "error": error}


def guard(stub):
    return AgentiSendGuard("as_test_key", key_id=KEY_ID, base_url="https://api.example.test", transport=stub)


def test_send_posts_to_emails_and_returns_the_id():
    stub = Stub((200, {"id": "msg_1"}))
    assert guard(stub).send({"from": "a@b.com", "to": "c@d.com", "subject": "s", "text": "t"}, idempotency_key="k1") == {"id": "msg_1"}
    method, url, headers, body = stub.calls[0]
    assert (method, url) == ("POST", "https://api.example.test/emails")
    assert headers["authorization"] == "Bearer as_test_key"
    assert headers["idempotency-key"] == "k1"
    assert body["to"] == "c@d.com"


@pytest.mark.parametrize(
    "code,outcome,reason,exc",
    [
        ("kill_switch_active", "refuse", "kill_switch_active", GuardRefused),
        ("agent_budget_exceeded", "refuse", "agent_budget_exceeded", GuardRefused),
        ("rate_ceiling_exceeded", "refuse", "rate_ceiling_exceeded", GuardRefused),
        ("suppressed_recipient", "refuse", "recipient_suppressed", GuardRefused),
        ("approval_required", "hold_for_approval", "recipient_requires_approval", ApprovalRequired),
    ],
)
def test_guard_codes_become_decisions(code, outcome, reason, exc):
    stub = Stub(err(403 if code != "rate_ceiling_exceeded" else 429, code, "The API stopped this send", retry_after_seconds=60))
    with pytest.raises(exc) as stopped:
        guard(stub).send({"to": "c@d.com"})
    d = stopped.value.decision
    assert (d.outcome, d.reason) == (outcome, reason)
    assert d.message == "The API stopped this send."
    assert d.evidence["enforced_by"] == "agentisend" and d.evidence["code"] == code
    assert is_valid_decision(d)


def test_a_loop_hold_keeps_the_loop_token_and_the_action_id():
    body = err(
        403,
        "approval_required",
        "Blocked: 3 near-identical emails already went to a@b.com within 60 minutes.",
        action_id="act_9",
        details={"outcome": "refuse", "reason": "loop_repetition_detected", "evidence": {"matching_sends_in_window": 3}},
    )
    with pytest.raises(ApprovalRequired) as held:
        guard(Stub(body)).send({"to": "a@b.com"})
    d = held.value.decision
    assert d.reason == "loop_repetition_detected"
    assert d.evidence["action_id"] == "act_9"
    assert d.evidence["matching_sends_in_window"] == 3


def test_other_errors_are_api_errors_not_decisions():
    with pytest.raises(AgentiSendAPIError) as e:
        guard(Stub(err(422, "domain_not_verified", "Verify the domain first."))).send({"to": "a@b.com"})
    assert e.value.code == "domain_not_verified" and e.value.status == 422
    assert decision_from_error(422, {"error": {"code": "domain_not_verified"}}) is None


def test_check_uses_preflight_and_sends_nothing():
    stub = Stub(
        (200, {"ok": True, "simulated": False, "error": None, "checks": {}}),
        (200, {"ok": False, "simulated": False, "error": {"code": "approval_required", "message": "Held for a person.", "fix": "x", "action_id": "act_1"}, "checks": {}}),
        (200, {"ok": False, "simulated": False, "error": {"code": "domain_not_verified", "message": "Verify the domain.", "fix": "x"}, "checks": {}}),
        err(403, "kill_switch_active", "This API key has been paused with the kill switch."),
    )
    g = guard(stub)
    ok = g.check({"to": "a@b.com"})
    assert (ok.outcome, ok.reason, ok.message) == ("allow", "ok", "No limit, loop or approval rule blocks this send.")
    assert stub.calls[0][:2] == ("POST", "https://api.example.test/emails/preflight")
    held = g.check({"to": "a@b.com"})
    assert held.outcome == "hold_for_approval" and held.evidence["action_id"] == "act_1"
    with pytest.raises(AgentiSendAPIError):
        g.check({"to": "a@b.com"})
    assert g.check({"to": "a@b.com"}).reason == "kill_switch_active"
    assert all(c[1].endswith("/emails/preflight") for c in stub.calls)


def test_apply_limits_maps_to_the_limits_endpoint():
    stub = Stub((200, {"budget_per_period": 500}), (200, {"rate_ceiling_per_minute": None}))
    g = guard(stub)
    g.apply_limits(budgets={"per_day": 500}, rate={"per_minute": 30})
    assert stub.calls[0][:2] == ("PATCH", f"https://api.example.test/limits/keys/{KEY_ID}")
    assert stub.calls[0][3] == {"budget_per_period": 500, "period": "daily", "rate_ceiling_per_minute": 30}
    g.apply_limits(rate={"per_minute": None})
    assert stub.calls[1][3] == {"rate_ceiling_per_minute": None}
    with pytest.raises(ValueError, match="one budget per key"):
        g.apply_limits(budgets={"per_day": 1, "per_hour": 1})


def test_kill_switch_and_approvals_hit_the_real_endpoints():
    stub = Stub((200, {"paused": True}), (200, {"data": []}), (200, {"budget_per_period": 10}))
    g = guard(stub)
    g.kill_switch.pause("looping")
    assert stub.calls[0][:2] == ("POST", f"https://api.example.test/limits/keys/{KEY_ID}/kill")
    assert stub.calls[0][3] == {"reason": "looping"}
    with pytest.raises(NotImplementedError, match="console"):
        g.kill_switch.resume()
    assert len(stub.calls) == 1  # resume never reaches the API
    g.approvals.list(limit=10)
    assert stub.calls[1][1] == "https://api.example.test/agent-actions?state=pending&limit=10"
    g.set_limits(budget=10, period="hourly")
    assert stub.calls[2][3] == {"budget_per_period": 10, "period": "hourly"}


def test_limits_calls_need_a_key_id_and_a_key(monkeypatch):
    monkeypatch.delenv("AGENTISEND_API_KEY", raising=False)
    with pytest.raises(ValueError):
        AgentiSendGuard()
    with pytest.raises(ValueError, match="key_id"):
        AgentiSendGuard("k", transport=Stub()).limits()
