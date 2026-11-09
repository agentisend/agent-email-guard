"""Port of b08-budget-race.test.ts: concurrent checks never overshoot a budget."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from agent_email_guard import AsyncGuard, Guard

SEND = {"to": "user@example.com", "subject": "Receipt", "text": "Thanks.", "key": "agent-race"}


def _many_threads(guard, n):
    barrier = threading.Barrier(n)

    def one(i):
        barrier.wait()
        return guard.check(dict(SEND, to=f"user{i}@example.com"))

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(one, range(n)))


def test_200_concurrent_threads_against_a_budget_of_50_admit_exactly_50(clock):
    guard = Guard(budgets={"per_day": 50}, rate={"per_minute": 10_000}, loop=False, clock=clock)
    results = _many_threads(guard, 200)
    admitted = [r for r in results if r.outcome == "allow"]
    refused = [r for r in results if r.reason == "agent_budget_exceeded"]
    assert len(admitted) == 50
    assert len(admitted) + len(refused) == 200
    assert max(r.evidence["day_used"] for r in admitted) == 50


def test_200_concurrent_coroutines_admit_exactly_50(clock):
    guard = AsyncGuard(budgets={"per_day": 50}, rate={"per_minute": 10_000}, loop=False, clock=clock)

    async def main():
        return await asyncio.gather(*(guard.check(dict(SEND, to=f"u{i}@example.com")) for i in range(200)))

    results = asyncio.run(main())
    assert sum(r.outcome == "allow" for r in results) == 50


def test_every_budget_refusal_names_the_token_and_the_numbers(clock):
    guard = Guard(budgets={"per_day": 1}, loop=False, clock=clock)
    assert guard.check(SEND).outcome == "allow"
    blocked = guard.check(SEND)
    assert blocked.outcome == "refuse"
    assert blocked.reason == "agent_budget_exceeded"
    assert blocked.evidence == {
        "key": "agent-race",
        "period": "day",
        "budget": 1,
        "used": 1,
        "resets_at": 1_800_057_600_000,
    }
    assert blocked.message == 'Key "agent-race" has used its daily budget of 1 email; it resets at 2027-01-16T00:00:00Z.'


def test_the_per_minute_ceiling_refuses_independently_and_consumes_no_budget(clock):
    guard = Guard(budgets={"per_day": 1_000}, rate={"per_minute": 5}, loop=False, clock=clock)
    for _ in range(5):
        assert guard.check(SEND).outcome == "allow"
    sixth = guard.check(SEND)
    assert sixth.reason == "rate_ceiling_exceeded"
    assert sixth.evidence["sends_in_window"] == 5
    assert sixth.evidence["ceiling_per_minute"] == 5
    assert sixth.evidence["retry_after_seconds"] == 60
    assert sixth.message == 'Key "agent-race" reached its ceiling of 5 sends per minute; wait 60 seconds and try again.'
    clock.now += 60_000
    # The refused attempt did not consume budget.
    assert guard.check(SEND).evidence["day_used"] == 6


def test_the_minute_is_sliding_not_fixed(clock):
    guard = Guard(rate={"per_minute": 2}, loop=False, clock=clock)
    guard.check(SEND)
    clock.now += 30_000
    guard.check(SEND)
    clock.now += 29_000
    assert guard.check(SEND).evidence["retry_after_seconds"] == 1
    clock.now += 1_000
    assert guard.check(SEND).outcome == "allow"


def test_a_budget_refusal_gives_back_the_rate_slot_and_earlier_budgets(clock):
    guard = Guard(budgets={"per_hour": 10, "per_day": 1}, rate={"per_minute": 2}, loop=False, clock=clock)
    assert guard.check(SEND).outcome == "allow"
    assert guard.check(SEND).reason == "agent_budget_exceeded"
    clock.now += 3_600_000
    d = guard.check(SEND)
    # the refused send's hourly increment and rate slot were returned
    assert d.reason == "agent_budget_exceeded"
    assert guard.store.get_counter(f"agent-email-guard:agent-race:budget:hour:{clock.now // 3_600_000 * 3_600_000}") == 0


def test_a_refused_send_leaves_no_partial_state(clock):
    guard = Guard(budgets={"per_hour": 10, "per_day": 1_000}, loop=False, clock=clock)
    results = _many_threads(guard, 40)
    assert sum(r.outcome == "allow" for r in results) == 10
    clock.now += 3_600_000
    assert guard.check(SEND).evidence["day_used"] == 11


def test_release_gives_back_exactly_what_check_reserved_once(clock):
    guard = Guard(budgets={"per_day": 2}, rate={"per_minute": 1}, loop=False, clock=clock)
    decision = guard.check(SEND)
    assert decision.outcome == "allow"
    guard.release(decision)
    guard.release(decision)  # safe twice
    again = guard.check(SEND)
    assert again.outcome == "allow"
    assert again.evidence["day_used"] == 1


def test_month_window_resets_on_the_first_of_the_month(clock):
    clock.now = int(datetime(2026, 12, 31, 23, 59, tzinfo=timezone.utc).timestamp() * 1000)
    guard = Guard(budgets={"per_month": 1}, loop=False, clock=clock)
    assert guard.check(SEND).outcome == "allow"
    refused = guard.check(SEND)
    assert refused.reason == "agent_budget_exceeded"
    assert refused.message.endswith("it resets at 2027-01-01T00:00:00Z.")
    clock.now += 60_000
    assert guard.check(SEND).outcome == "allow"
