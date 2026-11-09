"""The store contract every backend implements: five atomic operations, a send log and a state slot.

The rule that matters: ``increment_with_ceiling`` and ``window_add`` are each
ONE atomic step. Read-then-write is the bug this package exists to prevent:
two racing callers at ``used = budget - 1`` must not both get through.

Names are shared with the other language ports (``agent-email-guard:<key>:...``),
so a Python agent and a Node agent pointed at the same Redis or Postgres
count against the same budget.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

try:
    from typing import Protocol
except ImportError:  # pragma: no cover
    from typing_extensions import Protocol  # type: ignore

from ..loop import SendRecord

#: The send log keeps at most this many entries per key.
SEND_LOG_CAP = 10_000


@dataclass(frozen=True)
class CounterResult:
    #: True when the increment was applied.
    ok: bool
    #: The counter after the increment when ok, otherwise its unchanged value.
    value: int


@dataclass(frozen=True)
class WindowResult:
    ok: bool
    #: Members inside the window after the call (including the new one when ok).
    count: int
    #: Timestamp of the oldest member still inside the window, or None when empty.
    oldest_at: Optional[int]


class Store(Protocol):
    def increment_with_ceiling(
        self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]
    ) -> CounterResult:
        """Atomically: if value + amount <= ceiling (or ceiling is None), add and return ok; else change nothing."""
        ...

    def decrement(self, name: str, amount: int) -> None:
        """Subtract amount, never below 0."""
        ...

    def get_counter(self, name: str) -> int: ...

    def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        """Sliding window, atomically: drop members with at - member_at >= window_ms; add if count < ceiling."""
        ...

    def window_remove(self, name: str, member: str) -> None: ...

    def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        """Append to a key's send log; entries older than keep_ms before record.at may be dropped."""
        ...

    def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        """Every logged send with at >= since, oldest first."""
        ...

    def get_state(self, name: str) -> Optional[str]: ...

    def set_state(self, name: str, value: Optional[str]) -> None: ...


class AsyncStore(Protocol):
    async def increment_with_ceiling(
        self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]
    ) -> CounterResult: ...

    async def decrement(self, name: str, amount: int) -> None: ...

    async def get_counter(self, name: str) -> int: ...

    async def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult: ...

    async def window_remove(self, name: str, member: str) -> None: ...

    async def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None: ...

    async def recent_sends(self, log: str, since: int) -> List[SendRecord]: ...

    async def get_state(self, name: str) -> Optional[str]: ...

    async def set_state(self, name: str, value: Optional[str]) -> None: ...
