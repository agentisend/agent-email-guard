"""The public API: wrap, record, approvals, suppression, keys, async."""

import asyncio

import pytest

from agent_email_guard import ApprovalRequired, AsyncGuard, Guard, GuardRefused, create_guard, is_valid_decision


def test_wrap_checks_sends_and_records(clock):
    sent = []
    guard = create_guard(budgets={"per_day": 2}, clock=clock)
    send = guard.wrap(lambda payload: sent.append(payload) or {"id": len(sent)})
    assert send({"to": "a@x.com", "subject": "hi", "text": "one"}) == {"id": 1}
    assert send({"to": "b@x.com", "subject": "hi", "text": "two"}) == {"id": 2}
    with pytest.raises(GuardRefused) as err:
        send({"to": "c@x.com", "subject": "hi", "text": "three"})
    assert err.value.reason == "agent_budget_exceeded"
    assert err.value.decision.evidence["used"] == 2
    assert len(sent) == 2
    assert len(guard.store.recent_sends("agent-email-guard:default:log", 0)) == 2


def test_wrap_keeps_the_signature_and_name():
    def send_email(payload, *, retries=0):
        """Docstring."""
        return retries

    wrapped = Guard().wrap(send_email)
    assert wrapped.__name__ == "send_email" and wrapped.__doc__ == "Docstring."
    assert wrapped({"to": "a@x.com"}, retries=3) == 3


def test_a_provider_failure_releases_the_reservation(clock):
    guard = Guard(budgets={"per_day": 1}, clock=clock)

    def boom(payload):
        raise ConnectionError("provider down")

    with pytest.raises(ConnectionError):
        guard.wrap(boom)({"to": "a@x.com"})
    ok = guard.wrap(lambda p: "sent")
    assert ok({"to": "a@x.com"}) == "sent"


def test_extract_maps_any_call_shape(clock):
    guard = Guard(suppress=["@blocked.example"], clock=clock)
    send = guard.wrap(lambda sender, recipient, subject, body: "sent", extract=lambda s, r, sub, b: {"to": r, "subject": sub, "text": b})
    assert send("me@x.com", "you@x.com", "hi", "there") == "sent"
    with pytest.raises(GuardRefused) as err:
        send("me@x.com", "Boss <ceo@Blocked.example>", "hi", "there")
    assert err.value.decision.evidence == {"recipient": "ceo@blocked.example", "matched_rule": "@blocked.example"}
    assert err.value.decision.message == "ceo@blocked.example is on the suppression list (rule: @blocked.example), so this guard never sends to it."


def test_new_recipients_hold_until_approved_then_every_other_check_still_runs(clock):
    sent = []
    guard = Guard(approval={"new_recipients": True}, budgets={"per_day": 1}, clock=clock)
    send = guard.wrap(lambda p: sent.append(p) or "sent")
    with pytest.raises(ApprovalRequired) as held:
        send({"to": "new@person.example", "subject": "hello", "text": "first"})
    d = held.value.decision
    assert d.outcome == "hold_for_approval"
    assert d.evidence == {"rule": "new_recipient", "recipient": "new@person.example", "new_recipients": "new@person.example"}
    assert d.message == 'new@person.example has not received email from key "default" before, so this email waits for a person to approve it.'
    assert sent == []
    assert held.value.approve() == "sent"
    # Now known: no hold.
    with pytest.raises(GuardRefused):  # but the budget of 1 is spent
        send({"to": "new@person.example", "subject": "again", "text": "second"})


def test_recipient_rules_and_custom_rules_hold(clock):
    guard = Guard(approval={"recipients": ["@bigco.com"], "require_for": lambda s: "refund" in s["subject"] and "refunds team"}, clock=clock)
    d = guard.check({"to": ["x@y.com", "CEO@BigCo.com"], "subject": "hi"})
    assert d.evidence == {"rule": "recipient_list", "recipient": "ceo@bigco.com", "matched_rule": "@bigco.com"}
    assert d.message == "ceo@bigco.com matches the approval rule @bigco.com, so this email waits for a person to approve it."
    d = guard.check({"to": "x@y.com", "subject": "your refund"})
    assert d.evidence == {"rule": "custom", "detail": "refunds team"}
    assert guard.check({"to": "x@y.com", "subject": "your refund"}, approved=True).evidence["approved"] is True


def test_keys_count_separately(clock):
    guard = Guard(budgets={"per_hour": 1}, key="fallback", clock=clock)
    assert guard.check({"to": "a@x.com", "key": "agent-a"}).outcome == "allow"
    assert guard.check({"to": "a@x.com", "key": "agent-b"}).outcome == "allow"
    assert guard.check({"to": "a@x.com"}).evidence["key"] == "fallback"
    assert guard.check({"to": "a@x.com", "key": "agent-a"}).reason == "agent_budget_exceeded"


def test_recorded_sends_feed_loop_detection(clock):
    guard = Guard(clock=clock)
    send = guard.wrap(lambda p: "sent")
    payload = {"to": "victim@example.com", "subject": "Same", "text": "Same body every time."}
    for _ in range(3):
        send(payload)
        clock.now += 1_000
    with pytest.raises(GuardRefused) as err:
        send(payload)
    assert err.value.reason == "loop_repetition_detected"
    assert err.value.decision.message == (
        "Blocked: 3 near-identical emails already went to victim@example.com within 60 minutes, "
        "which matches a retry or script loop; review the agent before sending more."
    )


def test_allow_evidence_carries_window_stats_and_meters(clock):
    guard = Guard(budgets={"per_hour": 5, "per_month": 100}, rate={"per_minute": 3}, clock=clock)
    d = guard.check({"to": "a@x.com"})
    assert is_valid_decision(d)
    assert d.to_dict() == {
        "outcome": "allow",
        "reason": "ok",
        "message": "No limit, loop or approval rule blocks this send.",
        "evidence": {
            "key": "default",
            "window_size": 0,
            "distinct_recipients": 0,
            "entropy_bits": 0,
            "effective_recipients": 1,
            "rate_used": 1,
            "rate_ceiling": 3,
            "hour_used": 1,
            "hour_budget": 5,
            "month_used": 1,
            "month_budget": 100,
        },
    }


def test_bad_config_is_refused_at_construction():
    with pytest.raises(ValueError):
        Guard(budgets={"per_week": 1})
    with pytest.raises(ValueError):
        Guard(rate={"per_second": 1})
    with pytest.raises(ValueError):
        Guard(loop={"mode": "sometimes"})
    with pytest.raises(ValueError):
        Guard(approval={"everyone": True})


def test_sync_guard_refuses_an_async_rule(clock):
    async def rule(send):
        return True

    with pytest.raises(TypeError):
        Guard(approval={"require_for": rule}, clock=clock).check({"to": "a@x.com"})


def test_async_wrap_and_async_rule(clock):
    async def rule(send):
        return send["subject"] == "hold me"

    guard = AsyncGuard(approval={"require_for": rule}, budgets={"per_day": 5}, clock=clock)
    calls = []

    async def provider(payload):
        calls.append(payload)
        return "sent"

    send = guard.wrap(provider)

    async def main():
        assert await send({"to": "a@x.com", "subject": "fine"}) == "sent"
        with pytest.raises(ApprovalRequired) as held:
            await send({"to": "a@x.com", "subject": "hold me"})
        assert await held.value.approve() == "sent"
        return len(calls)

    assert asyncio.run(main()) == 2
