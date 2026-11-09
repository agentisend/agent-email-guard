"""Run every case in oss/agent-guard/spec/vectors/*.json (SPEC §9) against this package."""

import json
import math
from pathlib import Path

import pytest

from agent_email_guard import Guard, policy_problems, validate_policy

VECTORS = Path(__file__).resolve().parents[2] / "spec" / "vectors"
FILES = sorted(p for p in VECTORS.glob("*.json") if p.name != "vector.schema.json") if VECTORS.is_dir() else []
CASES = [(f, case) for f in FILES for case in json.loads(f.read_text())["cases"]]


class Clock:
    now = 0

    def __call__(self):
        return self.now


def build(config, clock):
    cfg = dict(config)
    approval = dict(cfg.pop("approval", {}) or {})
    rule = approval.pop("require_for", None)
    if rule is not None:
        needle, detail = rule["subject_contains"], rule.get("detail")

        def require_for(send):
            if needle in (send.get("subject") or ""):
                return detail if detail is not None else True
            return False

        approval["require_for"] = require_for
    return Guard(approval=approval or None, clock=clock, **cfg)


def same_number(a, b):
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool) and math.isclose(a, b, rel_tol=0, abs_tol=0)


def assert_evidence(actual, expected, where):
    assert set(actual) == set(expected), f"{where}: evidence keys differ: {sorted(actual)} vs {sorted(expected)}"
    for k, v in expected.items():
        got = actual[k]
        if isinstance(v, bool) or v is None or isinstance(v, str):
            assert got == v and type(got) is type(v), f"{where}: evidence[{k}] = {got!r}, expected {v!r}"
        else:
            assert same_number(got, v), f"{where}: evidence[{k}] = {got!r}, expected {v!r}"


def run_case(case):
    clock = Clock()
    guard = build(case["config"], clock)
    decisions = {}
    for i, step in enumerate(case["steps"]):
        clock.now = step["at"]
        op = step["op"]
        where = f"{case['name']} step {i} ({op})"
        if op in ("check", "send"):
            d = guard.check(step["send"], approved=step.get("approved", False))
            decisions[i] = d
            if op == "send" and d.outcome == "allow":
                guard.record(step["send"])
            exp = step.get("expect")
            if exp is not None:
                assert (d.outcome, d.reason) == (exp["outcome"], exp["reason"]), f"{where}: {d.outcome}/{d.reason} vs {exp['outcome']}/{exp['reason']}"
                assert d.message == exp["message"], f"{where}:\n  got      {d.message}\n  expected {exp['message']}"
                assert_evidence(d.evidence, exp["evidence"], where)
        elif op == "record":
            for _ in range(step.get("repeat", 1)):
                guard.record(step["send"])
                clock.now += step.get("every_ms", 0)
        elif op == "release":
            guard.release(decisions[step["step"]])
        elif op == "pause":
            if "by" in step:
                guard.kill_switch.pause(step["reason"], by=step["by"])
            else:
                guard.kill_switch.pause(step["reason"])
        elif op == "read_state":
            raw = guard.store.get_state(step["name"])
            assert {"state": json.loads(raw) if raw is not None else None} == step["expect"], where
        elif op == "resume":
            resumed = guard.kill_switch.resume(step["by"])
            if "expect" in step:
                assert resumed == step["expect"]["resumed"], where
        else:
            raise AssertionError(f"{where}: unknown op")


@pytest.mark.skipif(not CASES, reason="spec/vectors not present in this checkout")
@pytest.mark.parametrize("path,case", CASES, ids=[f"{p.stem}::{c['name']}" for p, c in CASES])
def test_vector(path, case):
    run_case(case)


POLICY_CASES = json.loads((VECTORS / "policy" / "validation.json").read_text())["cases"] if (VECTORS / "policy" / "validation.json").is_file() else []


@pytest.mark.parametrize("case", POLICY_CASES, ids=[c["name"] for c in POLICY_CASES])
def test_policy_vector(case):
    assert policy_problems(case["policy"]) == case["expect"]["problems"]
    if not case["expect"]["problems"]:
        Guard(**validate_policy(case["policy"]))  # a valid policy builds a guard


def test_the_vectors_are_present():
    assert len(FILES) >= 11 and len(CASES) >= 49 and len(POLICY_CASES) >= 10
