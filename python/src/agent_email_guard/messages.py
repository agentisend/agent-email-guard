"""Every sentence the guard can say, and the number formatting they use.

Reason tokens and these templates are part of the cross-language contract:
the Node, Python, PHP and Go ports render byte-identical strings, pinned by
the shared conformance vectors. Change one here only together with the spec.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Union

Number = Union[int, float]

PERIOD_ADJECTIVE = {"hour": "hourly", "day": "daily", "month": "monthly"}


def round3(n: float) -> Number:
    """Round half up to 3 decimals: floor(x * 1000 + 0.5) / 1000. Whole results come back as int."""
    r = math.floor(n * 1000 + 0.5) / 1000
    return int(r) if float(r).is_integer() else r


def format_number(n: Number) -> str:
    """Integers print without a decimal point; other numbers print the shortest round-trip decimal."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isfinite(n) and float(n).is_integer():
        return str(int(n))
    return repr(float(n))


def plural(n: Number, singular: str, plural_form: str = "") -> str:
    """"1 email", "2 emails"."""
    return f"{format_number(n)} {singular if n == 1 else (plural_form or singular + 's')}"


def format_instant(ms: int) -> str:
    """Epoch ms -> ``YYYY-MM-DDTHH:MM:SSZ`` (UTC, no fraction)."""
    return datetime.fromtimestamp(ms // 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ok() -> str:
    return "No limit, loop or approval rule blocks this send."


def kill_switch_active() -> str:
    return "Sending is paused by the kill switch, so nothing sends until a person resumes it."


def recipient_suppressed(recipient: str, rule: str) -> str:
    return f"{recipient} is on the suppression list (rule: {rule}), so this guard never sends to it."


def loop_repetition_detected(matches: int, to_line: str, minutes: int) -> str:
    return (
        f"Blocked: {plural(matches, 'near-identical email')} already went to {to_line} within "
        f"{plural(minutes, 'minute')}, which matches a retry or script loop; review the agent before sending more."
    )


def loop_both_signals(matches: int, to_line: str, effective: Number) -> str:
    return (
        f"Blocked: this key shows both a repetition loop ({plural(matches, 'near-identical email')} to {to_line}) "
        f"and collapsed recipient diversity (about {plural(effective, 'effective recipient')}); "
        "review the agent before sending more."
    )


def recipient_entropy_collapse(window_size: int, effective: Number) -> str:
    return (
        f"Blocked: the last {plural(window_size, 'email')} went to about {plural(effective, 'effective recipient')}, "
        "and this one goes to the same inbox again, which looks like a loop; mail to other recipients still sends."
    )


def approval_recipient_rule(recipient: str, rule: str) -> str:
    return f"{recipient} matches the approval rule {rule}, so this email waits for a person to approve it."


def approval_new_recipient(recipient: str, key: str) -> str:
    return f'{recipient} has not received email from key "{key}" before, so this email waits for a person to approve it.'


def approval_custom() -> str:
    return "Your approval rule matched this email, so it waits for a person to approve it."


def rate_ceiling_exceeded(key: str, ceiling: int, retry_after_seconds: int) -> str:
    return (
        f'Key "{key}" reached its ceiling of {plural(ceiling, "send")} per minute; '
        f"wait {plural(retry_after_seconds, 'second')} and try again."
    )


def agent_budget_exceeded(key: str, period: str, budget: int, resets_at: int) -> str:
    return (
        f'Key "{key}" has used its {PERIOD_ADJECTIVE[period]} budget of {plural(budget, "email")}; '
        f"it resets at {format_instant(resets_at)}."
    )
