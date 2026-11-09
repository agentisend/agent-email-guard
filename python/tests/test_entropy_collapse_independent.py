"""Port of entropy-collapse-independent.test.ts."""

import pytest

from agent_email_guard import detect_loop, recipient_entropy

NOW = 1_800_000_000_000


def mutated_content_loop(count):
    return [
        {
            "to": "target@example.com" if i % 2 == 0 else "target2@example.com",
            "subject": f"Following up — note {i} of my sequence",
            "body": (
                f"Message {i}: {'x' * (3 + (i % 7))} quick thought on your {['pricing', 'roadmap', 'team', 'growth'][i % 4]}"
                f" plans; happy to share what we learned with teams like yours this {['spring', 'summer', 'autumn', 'winter'][i % 4]}. Ref {i * 7919}."
            ),
            "sent_at": NOW - (count - i) * 5_000,
        }
        for i in range(count)
    ]


def test_flags_a_two_recipient_content_mutating_loop():
    result = detect_loop(
        mutated_content_loop(60),
        {
            "to": "target@example.com",
            "subject": "Following up — note 60 of my sequence",
            "body": "Message 60: xxx quick thought on your pricing plans; totally new wording entirely unrelated to prior sends. Ref 474540.",
        },
        NOW,
    )
    assert result.repetition.flagged is False
    assert result.repetition.matching_sends_in_window == 0
    assert result.entropy.flagged is True
    assert result.verdict == "entropy_collapse"
    assert result.decision.reason == "recipient_entropy_collapse"
    assert result.decision.outcome == "refuse"


def test_reports_the_entropy_math():
    window = mutated_content_loop(60)
    bits, distinct = recipient_entropy(window)
    assert distinct == 2
    assert bits == pytest.approx(1, abs=1e-5)
    result = detect_loop(window, {"to": "target@example.com", "subject": "new", "body": "new body text"}, NOW)
    assert result.entropy.effective_recipients == pytest.approx(2, abs=1e-3)
    assert result.decision.evidence["effective_recipients"] == pytest.approx(2, abs=1e-3)
    assert result.decision.evidence["distinct_recipients"] == 2
    assert "recipients" in result.decision.message.lower()


def test_diverse_window_of_the_same_size_stays_clean():
    diverse = [
        {
            "to": f"lead{i}@company{i % 30}.com",
            "subject": f"Outreach {i}",
            "body": f"Unique message {i} with plenty of distinct trigrams to keep similarity far below threshold.",
            "sent_at": NOW - (60 - i) * 5_000,
        }
        for i in range(60)
    ]
    result = detect_loop(diverse, {"to": "lead60@company30.com", "subject": "Outreach 60", "body": "A fresh unique message."}, NOW)
    assert result.entropy.flagged is False
    assert result.verdict == "clean"
