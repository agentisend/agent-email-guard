"""Port of sp04_entropy_collapse_holds_only_dominant_recipients.test.ts."""

from agent_email_guard import detect_loop, recipient_entropy

NOW = 1_800_000_000_000


def alerts_to(recipients, count):
    return [
        {
            "to": ",".join(recipients),
            "subject": f"Alert {i}: {['disk', 'queue', 'latency', 'errors'][i % 4]} on host {i * 13}",
            "body": f"Check {i} crossed its threshold at step {i * 7919}; {'z' * (i % 9)} {['north', 'south', 'east', 'west'][i % 4]} region.",
            "sent_at": NOW - (count - i) * 60_000,
        }
        for i in range(count)
    ]


def test_new_recipient_passes_a_key_collapsed_on_one_inbox():
    result = detect_loop(
        alerts_to(["owner@example.test"], 30),
        {"to": "new-user@example.com", "subject": "Your sign-in code", "body": "Your code is 481 902."},
        NOW,
    )
    assert result.entropy.window_collapsed is True
    assert result.entropy.flagged is False
    assert result.verdict == "clean"
    assert result.decision is None


def test_still_holds_the_next_send_to_the_collapsed_inbox():
    result = detect_loop(
        alerts_to(["owner@example.test"], 30),
        {"to": "owner@example.test", "subject": "Alert 30: new wording", "body": "A different sentence entirely."},
        NOW,
    )
    assert result.verdict == "entropy_collapse"
    assert result.decision.reason == "recipient_entropy_collapse"
    assert result.decision.evidence["candidate_recipient_share"] == 1


def test_counts_each_address_on_a_send():
    window = alerts_to(["owner@example.test", "cfo@example.test"], 30)
    assert recipient_entropy(window)[1] == 2
    result = detect_loop(window, {"to": "owner@example.test", "subject": "Something else", "body": "Unrelated copy."}, NOW)
    assert result.verdict == "entropy_collapse"


def test_holds_a_candidate_that_reaches_a_dominant_inbox_through_cc():
    result = detect_loop(
        alerts_to(["owner@example.test"], 30),
        {
            "to": "new-user@example.com",
            "recipients": ["new-user@example.com", "owner@example.test"],
            "subject": "Welcome",
            "body": "Welcome aboard.",
        },
        NOW,
    )
    assert result.verdict == "entropy_collapse"


def test_reads_cc_recipients_in_the_window():
    window = [
        dict(s, to=f"rotating-{i % 2}@example.test", recipients=[f"rotating-{i % 2}@example.test", "owner@example.test"])
        for i, s in enumerate(alerts_to(["ops-inbox@example.test"], 30))
    ]
    assert recipient_entropy(window)[1] == 3
    assert detect_loop(window, {"to": "owner@example.test", "subject": "s", "body": "b"}, NOW).verdict == "entropy_collapse"
