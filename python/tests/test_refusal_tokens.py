"""Port of refusal-tokens.test.ts: every refusal carries a machine token and a human sentence.

The catalog-mapping half of the TypeScript test (toApiError) belongs to the
hosted product and has no counterpart here; the hosted adapter's mapping is
pinned in test_agentisend_adapter.py instead.
"""

import re

from agent_email_guard import REASON_TOKENS, Guard, is_valid_decision

NOW = 1_800_000_000_000


def all_refusals(clock):
    out = []
    loopy = Guard(clock=clock)
    for i in range(30):
        loopy.record({"to": "same@recipient.com", "subject": "identical subject", "text": f"body variant {i % 3}"})
    out.append(loopy.check({"to": "same@recipient.com", "subject": "identical subject", "text": "body variant 1"}))

    collapsed = Guard(clock=clock)
    for i in range(25):
        collapsed.record({"to": "one@x.com", "subject": f"s{i}", "text": f"b {i}"})
    out.append(collapsed.check({"to": "one@x.com", "subject": "new", "text": "new"}))

    budget = Guard(budgets={"per_day": 1}, clock=clock)
    budget.check({"to": "a@x.com"})
    out.append(budget.check({"to": "a@x.com"}))

    rate = Guard(rate={"per_minute": 1}, clock=clock)
    rate.check({"to": "a@x.com"})
    out.append(rate.check({"to": "a@x.com"}))

    killed = Guard(clock=clock)
    killed.kill_switch.pause("why", by="op")
    out.append(killed.check({"to": "a@x.com"}))

    approval = Guard(
        approval={"recipients": ["@bigco.com"], "new_recipients": True, "require_for": lambda s: "wire" in s.get("subject", "")},
        suppress=["regulator@gov.example"],
        clock=clock,
    )
    out.append(approval.check({"to": "ceo@bigco.com"}))
    out.append(approval.check({"to": "regulator@gov.example"}))
    out.append(approval.check({"to": "new@person.example"}))
    out.append(approval.check({"to": "known@person.example", "subject": "wire transfer"}))
    return [d for d in out if d.outcome != "allow"]


def test_every_blocking_subsystem_produces_a_refusal(clock):
    refusals = all_refusals(clock)
    reasons = {r.reason for r in refusals}
    assert reasons == set(REASON_TOKENS) - {"ok"}
    assert len(refusals) >= 9


def test_every_refusal_validates_the_contract(clock):
    for r in all_refusals(clock):
        assert is_valid_decision(r), r
        assert isinstance(r.evidence, dict)


def test_every_sentence_is_plain_and_complete(clock):
    for r in all_refusals(clock):
        assert len(r.message) > 30
        assert not re.search(r"\bNone\b|\bundefined\b|\bnull\b|\[object|<agentisend", r.message)


def test_hosted_only_tokens_are_not_in_the_library():
    assert "brand_impersonation" not in REASON_TOKENS
    assert "trust_paused" not in REASON_TOKENS
