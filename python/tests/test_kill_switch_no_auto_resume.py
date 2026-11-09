"""Port of kill-switch-no-auto-resume.test.ts."""

import asyncio

from agent_email_guard import AsyncGuard, Guard

SEND = {"to": "a@example.com", "subject": "s", "text": "b"}


def test_refuses_every_send_while_paused_with_who_when_why(clock):
    clock.now = 1_000
    guard = Guard(clock=clock)
    assert guard.check(SEND).outcome == "allow"
    guard.kill_switch.pause("Agent was looping on one recipient.", by="operator-7")
    clock.now = 5_000
    d = guard.check(SEND)
    assert d.outcome == "refuse"
    assert d.reason == "kill_switch_active"
    assert d.evidence == {"paused_at": 1_000, "paused_by": "operator-7", "pause_reason": "Agent was looping on one recipient."}
    assert d.message == "Sending is paused by the kill switch, so nothing sends until a person resumes it."


def test_never_resumes_on_a_timer(clock):
    guard = Guard(clock=clock)
    guard.kill_switch.pause("Entropy collapse detected.", by="trust-system")
    clock.now += 365 * 24 * 60 * 60 * 1000
    assert guard.kill_switch.state().paused
    assert guard.check(SEND).reason == "kill_switch_active"


def test_resumes_only_via_explicit_resume(clock):
    clock.now = 1_000
    guard = Guard(clock=clock)
    state = guard.kill_switch.pause("Loop suspected.", by="operator-7")
    assert (state.paused, state.paused_at, state.paused_by, state.reason) == (True, 1_000, "operator-7", "Loop suspected.")
    clock.now = 86_400_000
    assert guard.kill_switch.state().paused
    assert guard.kill_switch.resume("operator-3") is True
    assert guard.kill_switch.state().paused is False
    assert guard.check(SEND).outcome == "allow"


def test_a_redundant_resume_returns_false_and_records_nothing(clock):
    guard = Guard(clock=clock)
    assert guard.kill_switch.resume("op") is False
    assert guard.store.get_state("agent-email-guard:kill") is None


def test_re_pausing_reports_the_latest_pause(clock):
    guard = Guard(clock=clock)
    guard.kill_switch.pause("one", by="a")
    guard.kill_switch.resume("b")
    guard.kill_switch.pause("three", by="c")
    assert guard.check(SEND).evidence["paused_by"] == "c"


def test_the_kill_switch_covers_every_key(clock):
    guard = Guard(clock=clock)
    guard.kill_switch.pause("all stop")
    assert guard.check(dict(SEND, key="other-agent")).reason == "kill_switch_active"
    assert guard.check(SEND).evidence["paused_by"] == "agent-email-guard"


def test_async_kill_switch_behaves_the_same(clock):
    guard = AsyncGuard(clock=clock)

    async def main():
        await guard.kill_switch.pause("stop", by="op")
        clock.now += 10**12
        assert (await guard.check(SEND)).reason == "kill_switch_active"
        assert await guard.kill_switch.resume("op2") is True
        return await guard.check(SEND)

    assert asyncio.run(main()).outcome == "allow"
