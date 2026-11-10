"""Glue between a framework tool and the published agent_email_guard package.

PyPI: agent-email-guard. Import: agent_email_guard. Wrappers take a Guard
(or anything with the same check, record and release), so the tests pass a
real Guard with the in-memory store and a fixed clock. The three Python
integrations carry identical copies of this file.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from agent_email_guard import Decision, Guard

Send = Callable[[dict[str, object]], dict[str, str]]

# 2026-11-10T12:00:00Z, so a test's daily window is fixed.
TEST_NOW_MS = 1_794_312_000_000


class EmailGuard(Protocol):
    def check(self, send: Any, *, approved: bool = False) -> Decision: ...

    def record(self, send: Any) -> None: ...

    def release(self, decision: Decision) -> None: ...


def decision_text(decision: Decision) -> str:
    """Text the model reads when a send does not go out. The reason token stays in brackets."""
    if decision.outcome == "hold_for_approval":
        return f"Approval required. {decision.message} [{decision.reason}]"
    return f"{decision.message} [{decision.reason}]"


def to_email_send(payload: dict[str, object], key: str | None) -> dict[str, object]:
    send: dict[str, object] = {"to": str(payload["to"]), "subject": str(payload["subject"])}
    for field in ("cc", "bcc", "text", "html"):
        value = payload.get(field)
        if isinstance(value, str) and value:
            send[field] = value
    if key:
        send["key"] = key
    return send


def send_allowed(guard: EmailGuard, send: Send, email: dict[str, object], decision: Decision) -> str:
    """After an allow: send, then record; release the decision when the send raises."""
    try:
        result = send(email)
    except Exception:
        guard.release(decision)
        raise
    guard.record(email)
    return f"Sent {result['id']}"


def send_through_guard(
    guard: EmailGuard, send: Send, email: dict[str, object], *, approved: bool = False
) -> str:
    """check, then send. approved=True is a person's yes on a held send: it skips the
    approval rules only, so budgets, the rate ceiling and loop detection still apply."""
    decision = guard.check(email, approved=approved)
    if decision.outcome != "allow":
        return decision_text(decision)
    return send_allowed(guard, send, email, decision)


def make_test_guard(**config: Any) -> Guard:
    """A real Guard with the in-memory store and a fixed clock."""
    return Guard(clock=lambda: TEST_NOW_MS, **config)


class Transport:
    """Records sends in memory. Never opens a socket."""

    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self._fail = False

    def fail_next(self) -> None:
        self._fail = True

    def send(self, email: dict[str, object]) -> dict[str, str]:
        if self._fail:
            self._fail = False
            raise RuntimeError("stub transport refused the send before any network call")
        self.sent.append(email)
        return {"id": f"stub-{len(self.sent)}"}
