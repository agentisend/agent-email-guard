"""The policy file (SPEC §2.9): the declarative part of the config as JSON, shared by every language.

``agent-email-guard.json`` uses the snake_case keys of the spec's conformance vectors::

    {
      "version": 1,
      "key": "support-agent",
      "budgets": {"per_hour": 50, "per_day": 300, "per_month": 5000},
      "rate": {"per_minute": 10},
      "loop": {"mode": "full", "max_identical_sends": 3},
      "approval": {"new_recipients": false, "recipients": ["@bigcustomer.com"]},
      "suppress": ["@competitor.example"]
    }

Every key is optional. Anything else rejects the whole file; every problem is
reported, in file order, with the spec's exact sentences. ``require_for``, the
store and the clock stay in code: pass them to ``Guard.from_policy``.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Mapping, Optional, Union

POLICY_FILE = "agent-email-guard.json"


class PolicyError(ValueError):
    """The policy file has problems. ``.problems`` lists every sentence, in file order."""

    def __init__(self, problems: List[str]) -> None:
        self.problems = list(problems)
        super().__init__(" ".join(self.problems))


def _int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _positive(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def _strings(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _nonempty(v: Any) -> bool:
    return isinstance(v, str) and v != ""


def _anything(v: Any) -> bool:
    return True


Check = Callable[[Any], bool]
_SCHEMA: Dict[str, Union[Check, Dict[str, Check]]] = {
    "$schema": _anything,
    "$comment": _anything,
    "version": lambda v: v == 1 and not isinstance(v, bool),
    "key": _nonempty,
    "namespace": _nonempty,
    "budgets": {"per_hour": _int, "per_day": _int, "per_month": _int},
    "rate": {"per_minute": _int},
    "loop": {
        "mode": lambda v: v in ("full", "repetition_only", "off"),
        "window_ms": _int,
        "similarity_threshold": _positive,
        "max_identical_sends": _int,
        "min_window_for_entropy": _int,
        "recipient_perplexity_floor": _positive,
    },
    "approval": {"new_recipients": lambda v: isinstance(v, bool), "recipients": _strings},
    "suppress": _strings,
}
_IGNORED = ("$schema", "$comment", "version")


def policy_problems(data: Any) -> List[str]:
    """Every problem in a parsed policy, in file order, as SPEC §2.9 sentences. Empty when valid."""
    if not isinstance(data, Mapping):
        return ["The policy must be a JSON object."]
    problems: List[str] = []
    for key, value in data.items():
        rule = _SCHEMA.get(key)
        if rule is None:
            problems.append(f'Unknown key "{key}".')
        elif isinstance(rule, dict):
            if not isinstance(value, Mapping):
                problems.append(f'"{key}" must be an object.')
                continue
            for sub, sub_value in value.items():
                check = rule.get(sub)
                if check is None:
                    problems.append(f'Unknown key "{key}.{sub}".')
                elif not check(sub_value):
                    problems.append(f'"{key}.{sub}" has the wrong type.')
        elif not rule(value):
            problems.append(f'"{key}" has the wrong type.')
    return problems


def validate_policy(data: Any) -> Dict[str, Any]:
    """Check a parsed policy; return Guard keyword arguments. Raises :class:`PolicyError` listing every problem."""
    problems = policy_problems(data)
    if problems:
        raise PolicyError(problems)
    return {k: (dict(v) if isinstance(v, Mapping) else v) for k, v in data.items() if k not in _IGNORED}


def load_policy(path: Optional[Union[str, "os.PathLike[str]"]] = None) -> Dict[str, Any]:
    """Read and check a policy file (default ``./agent-email-guard.json``). Returns Guard keyword arguments."""
    target = os.fspath(path) if path is not None else POLICY_FILE
    with open(target, encoding="utf-8") as fh:
        return validate_policy(json.load(fh))
