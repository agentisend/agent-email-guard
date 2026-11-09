"""The decision every guard call returns.

Every decision (allow, hold, refuse) carries a stable snake_case ``reason``
token and a full human sentence. A bare boolean is never returned: "blocked"
without evidence is how a support ticket starts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple, Union

try:  # Python 3.8+ has Literal in typing; 3.9 is our floor.
    from typing import Literal
except ImportError:  # pragma: no cover
    from typing_extensions import Literal  # type: ignore

Outcome = Literal["allow", "hold_for_approval", "refuse"]

#: Stable reason tokens. Machines switch on these; the strings never change
#: within a major version and are the same in every language port.
REASON_TOKENS: Tuple[str, ...] = (
    "ok",
    "kill_switch_active",
    "recipient_suppressed",
    "loop_repetition_detected",
    "recipient_entropy_collapse",
    "recipient_requires_approval",
    "rate_ceiling_exceeded",
    "agent_budget_exceeded",
)

EvidenceValue = Union[str, int, float, bool, None]
Evidence = Dict[str, Any]


@dataclass(frozen=True, eq=False)
class Reservation:
    """The counters and rate-window slot one ``check()`` took. JSON-serializable via ``to_dict``."""

    key: str
    counters: Tuple[Tuple[str, int], ...] = ()
    window: Optional[Tuple[str, str]] = None  # (window name, member)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "counters": [{"name": n, "amount": a} for n, a in self.counters],
            "window": {"name": self.window[0], "member": self.window[1]} if self.window else None,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Reservation":
        """Rebuild a reservation that crossed a process boundary (``to_dict`` -> JSON -> here)."""
        window = data.get("window")
        return cls(
            key=data["key"],
            counters=tuple((c["name"], int(c["amount"])) for c in data.get("counters", ())),
            window=(window["name"], window["member"]) if window else None,
        )


@dataclass(frozen=True)
class Decision:
    """The answer to "may this send go out?".

    ``outcome`` is what to do, ``reason`` is the stable token, ``message`` is a
    sentence a person can read, ``evidence`` holds the numbers behind it.
    """

    outcome: Outcome
    reason: str
    message: str
    evidence: Evidence = field(default_factory=dict)
    #: What an ``allow`` reserved, so ``release()`` gives back exactly that.
    #: Not part of the language-neutral shape.
    reservation: Optional["Reservation"] = field(default=None, compare=False, repr=False)

    @property
    def allowed(self) -> bool:
        return self.outcome == "allow"

    def to_dict(self) -> Dict[str, Any]:
        """The language-neutral shape: outcome, reason, message, evidence."""
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "message": self.message,
            "evidence": dict(self.evidence),
        }


def allow(reason: str, message: str, evidence: Optional[Evidence] = None) -> Decision:
    return Decision("allow", reason, message, dict(evidence or {}))


def hold_for_approval(reason: str, message: str, evidence: Optional[Evidence] = None) -> Decision:
    return Decision("hold_for_approval", reason, message, dict(evidence or {}))


def refuse(reason: str, message: str, evidence: Optional[Evidence] = None) -> Decision:
    return Decision("refuse", reason, message, dict(evidence or {}))


def is_valid_decision(d: Decision) -> bool:
    """Contract check: a known token, a sentence of 8+ characters ending in a period, a dict of evidence."""
    if d.outcome not in ("allow", "hold_for_approval", "refuse"):
        return False
    if d.reason not in REASON_TOKENS:
        return False
    if not isinstance(d.message, str) or len(d.message.strip()) < 8:
        return False
    if not d.message.strip().endswith("."):
        return False
    if not isinstance(d.evidence, dict):
        return False
    if (d.reason == "ok") != (d.outcome == "allow"):
        return False
    return True
