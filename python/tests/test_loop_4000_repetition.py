"""Port of loop-4000-repetition.test.ts: the 4,000-identical-send retry loop."""

from agent_email_guard import detect_loop

NOW = 1_800_000_000_000
SUBJECT = "Quick question about your roadmap"
BODY = "Hi — I wanted to follow up on my last note about your Q3 roadmap. Any interest?"
CANDIDATE = {"to": "victim@example.com", "subject": SUBJECT, "body": BODY}


def identical_sends(count):
    return [
        {"to": "victim@example.com", "subject": SUBJECT, "body": BODY, "sent_at": NOW - (count - i) * 10}
        for i in range(count)
    ]


def test_catches_the_4001st_near_identical_send():
    result = detect_loop(identical_sends(4000), CANDIDATE, NOW)
    assert result.verdict in ("repetition_loop", "both_signals")
    assert result.decision.outcome == "refuse"
    assert result.decision.reason == "loop_repetition_detected"


def test_carries_counts_window_and_similarity():
    tweaked = dict(CANDIDATE, body="Hi — I wanted to follow up on my last note about my Q3 roadmap. Any interest?")
    ev = detect_loop(identical_sends(4000), tweaked, NOW).decision.evidence
    assert ev["matching_sends_in_window"] == 4000
    assert ev["repetition_threshold"] == 3
    assert ev["window_ms"] == 60 * 60 * 1000
    assert ev["closest_subject_similarity"] > 0.99
    assert ev["closest_body_similarity"] >= 0.85


def test_explains_itself_in_a_sentence_ending_in_a_period():
    result = detect_loop(identical_sends(4000), CANDIDATE, NOW)
    assert result.repetition.flagged
    assert "near-identical emails" in result.decision.message
    assert result.decision.message.strip().endswith(".")


def test_flags_once_the_threshold_is_crossed_not_before():
    assert detect_loop(identical_sends(2), CANDIDATE, NOW).verdict == "clean"
    assert detect_loop(identical_sends(3), CANDIDATE, NOW).verdict == "repetition_loop"


def test_sends_outside_the_window_do_not_count():
    stale = [dict(s, sent_at=NOW - 2 * 60 * 60 * 1000) for s in identical_sends(50)]
    assert detect_loop(stale, CANDIDATE, NOW).verdict == "clean"
