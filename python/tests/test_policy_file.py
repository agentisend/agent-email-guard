"""agent-email-guard.json: the guard's config as a file."""

import json

import pytest

from agent_email_guard import POLICY_FILE, AsyncGuard, Guard, PolicyError, load_policy


def write(tmp_path, data):
    path = tmp_path / POLICY_FILE
    path.write_text(json.dumps(data))
    return path


def test_policy_file_builds_the_same_guard(tmp_path, clock, monkeypatch):
    write(tmp_path, {"key": "support", "budgets": {"per_hour": 1}, "approval": {"recipients": ["@big.example"]}, "suppress": ["@no.example"]})
    monkeypatch.chdir(tmp_path)
    guard = Guard.from_policy(clock=clock)  # default file name in the working directory
    assert guard.check({"to": "a@no.example"}).reason == "recipient_suppressed"
    assert guard.check({"to": "a@big.example"}).reason == "recipient_requires_approval"
    assert guard.check({"to": "a@x.example"}).evidence["key"] == "support"
    assert guard.check({"to": "a@x.example"}).reason == "agent_budget_exceeded"


def test_require_for_comes_from_code_and_overrides_win(tmp_path, clock):
    path = write(tmp_path, {"approval": {"new_recipients": False}, "rate": {"per_minute": 1}})
    guard = Guard.from_policy(path, require_for=lambda s: "wire" in s.get("subject", ""), rate={"per_minute": 5}, clock=clock)
    assert guard.check({"to": "a@x.com", "subject": "wire money"}).evidence["rule"] == "custom"
    assert guard.check({"to": "a@x.com"}).evidence["rate_ceiling"] == 5
    assert isinstance(AsyncGuard.from_policy(path), AsyncGuard)


@pytest.mark.parametrize(
    "data,message",
    [
        ({"budgets": {"perDay": 1}}, 'Unknown key "budgets.perDay".'),
        ({"budget": {"per_day": 1}}, 'Unknown key "budget".'),
        ({"loop": {"mode": "sometimes"}}, '"loop.mode" has the wrong type.'),
        ({"rate": {"per_minute": -1}}, '"rate.per_minute" has the wrong type.'),
        ({"rate": {"per_minute": True}}, '"rate.per_minute" has the wrong type.'),
        ({"loop": {"similarity_threshold": 0}}, '"loop.similarity_threshold" has the wrong type.'),
        ({"approval": {"require_for": "x"}}, 'Unknown key "approval.require_for".'),
        ({"suppress": "@x.com"}, '"suppress" has the wrong type.'),
        ({"version": 2}, '"version" has the wrong type.'),
        ({"namespace": ""}, '"namespace" has the wrong type.'),
    ],
)
def test_bad_policy_files_are_refused_naming_the_key(tmp_path, data, message):
    with pytest.raises(PolicyError) as err:
        load_policy(write(tmp_path, data))
    assert err.value.problems == [message]


def test_spec_example_policy_loads(tmp_path):
    spec = {
        "$schema": "x",
        "version": 1,
        "key": "support-agent",
        "budgets": {"per_hour": 50, "per_day": 300, "per_month": 5000},
        "rate": {"per_minute": 10},
        "loop": {"mode": "full", "window_ms": 3600000, "similarity_threshold": 0.85, "max_identical_sends": 3, "min_window_for_entropy": 20, "recipient_perplexity_floor": 3},
        "approval": {"new_recipients": False, "recipients": ["@bigcustomer.com"]},
        "suppress": ["@competitor.example"],
    }
    config = load_policy(write(tmp_path, spec))
    assert "version" not in config and "$schema" not in config
    assert Guard(**config).check({"to": "a@competitor.example"}).reason == "recipient_suppressed"
