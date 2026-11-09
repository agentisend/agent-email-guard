"""Exceptions a wrapped send raises. Each carries the full :class:`Decision`; nothing was sent."""

from __future__ import annotations

from typing import Any, Callable, Optional

from .decisions import Decision


class GuardError(Exception):
    """Base class: the guard stopped a send. ``.decision`` says why."""

    def __init__(self, decision: Decision) -> None:
        self.decision = decision
        self.reason = decision.reason
        super().__init__(decision.message)


class GuardRefused(GuardError):
    """The send was refused: the kill switch, a suppression, a loop, the rate ceiling or a budget."""


class ApprovalRequired(GuardError):
    """A person has to approve this send first.

    Keep it in your own queue. When a person approves, call :meth:`approve`:
    it re-runs every other check (kill switch, loop, rate, budgets) and sends.
    With :class:`~agent_email_guard.AsyncGuard`, ``approve()`` returns a coroutine.
    """

    def __init__(self, decision: Decision, approve: Optional[Callable[[], Any]] = None) -> None:
        super().__init__(decision)
        self._approve = approve

    def approve(self) -> Any:
        if self._approve is None:
            raise RuntimeError("this ApprovalRequired was not raised by a wrapped send, so there is nothing to approve.")
        return self._approve()
