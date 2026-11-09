"""Port of loop_guard_mode_repetition_only_ignores_entropy_collapse.test.ts."""

from agent_email_guard import detect_loop

NOW = 1_800_000_000_000


def collapsed(count):
    return [
        {
            "to": "owner@example.com",
            "subject": f"Alert {i} {'abc' * (i % 5)}",
            "body": f"Reading {i * 17} crossed {'z' * (i % 7)} in region {i}.",
            "sent_at": NOW - (count - i) * 60_000,
        }
        for i in range(count)
    ]


CANDIDATE = {"to": "owner@example.com", "subject": "A new sentence", "body": "Nothing like the alerts."}


def test_repetition_only_does_not_hold_a_dominant_recipient():
    result = detect_loop(collapsed(30), CANDIDATE, NOW, {"mode": "repetition_only"})
    assert result.entropy.window_collapsed is True
    assert result.entropy.flagged is False
    assert result.verdict == "clean"


def test_hyphenated_mode_name_is_accepted():
    assert detect_loop(collapsed(30), CANDIDATE, NOW, {"mode": "repetition-only"}).verdict == "clean"


def test_off_holds_nothing_including_a_repeated_body():
    window = [dict(s, subject="same", body="same body") for s in collapsed(4)]
    result = detect_loop(window, {"to": "owner@example.com", "subject": "same", "body": "same body"}, NOW, {"mode": "off"})
    assert result.verdict == "clean"
    assert result.repetition.flagged is False


def test_full_still_holds_the_dominant_recipient():
    assert detect_loop(collapsed(30), CANDIDATE, NOW, {"mode": "full"}).verdict == "entropy_collapse"
