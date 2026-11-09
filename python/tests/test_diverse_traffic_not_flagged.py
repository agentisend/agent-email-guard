"""Port of diverse-traffic-not-flagged.test.ts: legitimate traffic is not flagged."""

import math

from agent_email_guard import detect_loop

NOW = 1_800_000_000_000
FIRST = ["ana", "belle", "carlos", "dee", "elena", "farid", "gita", "hugo", "ines", "jonas"]
LAST = ["acme", "bright", "cedarline", "deltaworks", "everly", "foxglove", "granitetech"]
TOPICS = ["invoice", "receipt", "welcome", "password reset", "weekly digest", "shipping notice"]


def lcg(seed):
    state = seed & 0xFFFFFFFF

    def rand():
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0xFFFFFFFF

    return rand


def legitimate_traffic(count, seed):
    rand = lcg(seed)
    out = []
    for i in range(count):
        to = f"{FIRST[math.floor(rand() * len(FIRST))]}@{LAST[math.floor(rand() * len(LAST))]}.com"
        subject = f"Your {TOPICS[math.floor(rand() * len(TOPICS))]} (#{math.floor(rand() * 100000)})"
        body = (
            f"Hello {FIRST[math.floor(rand() * len(FIRST))]}, here are the details you asked for regarding "
            f"{TOPICS[math.floor(rand() * len(TOPICS))]}. Reference {math.floor(rand() * 1e9)}."
        )
        out.append({"to": to, "subject": subject, "body": body, "sent_at": NOW - (count - i) * 30_000})
    return out


def test_clears_120_varied_transactional_sends():
    result = detect_loop(
        legitimate_traffic(120, 42),
        {
            "to": "newcustomer@brightco.io",
            "subject": "Your invoice (#88213)",
            "body": "Hello ana, here are the details you asked for regarding invoice. Reference 554032987.",
        },
        NOW,
    )
    assert result.verdict == "clean"
    assert result.decision is None
    assert result.entropy.distinct_recipients > 40
    assert result.entropy.effective_recipients > 10
    assert result.repetition.matching_sends_in_window == 0


def test_small_honest_agent_below_the_sample_floor_is_not_guessed_at():
    result = detect_loop(legitimate_traffic(12, 7), {"to": "one@of-the-three.com", "subject": "s", "body": "b"}, NOW)
    assert result.entropy.trusted_sample is False
    assert result.entropy.flagged is False
    assert result.verdict == "clean"


def test_repeat_correspondence_with_individual_content_is_clean():
    window = []
    for rnd in range(6):
        for c in range(25):
            window.append(
                {
                    "to": f"customer{c}@theirco.com",
                    "subject": f"Re: ticket {c} update {rnd}",
                    "body": f"Round {rnd} for ticket {c}: we reproduced the issue on build {rnd}{c} and shipped a fix candidate.",
                    "sent_at": NOW - (150 - len(window)) * 20_000,
                }
            )
    result = detect_loop(
        window,
        {"to": "customer7@theirco.com", "subject": "Re: ticket 7 update 6", "body": "Round 6 for ticket 7: fix verified in staging."},
        NOW,
    )
    assert result.repetition.flagged is False
    assert result.entropy.flagged is False
    assert result.verdict == "clean"
