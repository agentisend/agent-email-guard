"""In-memory store: the default. One process, thread-safe, nothing shared.

Two processes with their own memory stores enforce two separate budgets; use
the Redis or Postgres store for that.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional, Tuple

from ..loop import SendRecord
from .base import SEND_LOG_CAP, CounterResult, WindowResult


class MemoryStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Dict[str, Tuple[int, Optional[int]]] = {}
        self._windows: Dict[str, Dict[str, int]] = {}
        self._logs: Dict[str, List[SendRecord]] = {}
        self._state: Dict[str, str] = {}

    def increment_with_ceiling(
        self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]
    ) -> CounterResult:
        with self._lock:
            current = self._counters.get(name, (0, None))[0]
            if ceiling is not None and current + amount > ceiling:
                return CounterResult(False, current)
            self._counters[name] = (current + amount, expires_at)
            return CounterResult(True, current + amount)

    def decrement(self, name: str, amount: int) -> None:
        with self._lock:
            entry = self._counters.get(name)
            if entry is not None:
                self._counters[name] = (max(0, entry[0] - amount), entry[1])

    def get_counter(self, name: str) -> int:
        with self._lock:
            return self._counters.get(name, (0, None))[0]

    def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        with self._lock:
            win = {m: t for m, t in self._windows.get(name, {}).items() if at - t < window_ms}
            self._windows[name] = win
            oldest = min(win.values()) if win else None
            if len(win) >= ceiling:
                return WindowResult(False, len(win), oldest)
            win[member] = at
            return WindowResult(True, len(win), oldest if oldest is not None else at)

    def window_remove(self, name: str, member: str) -> None:
        with self._lock:
            self._windows.get(name, {}).pop(member, None)

    def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        with self._lock:
            entries = self._logs.setdefault(log, [])
            entries.append(record)
            drop = 0
            while drop < len(entries) and record.at - entries[drop].at > keep_ms:
                drop += 1
            if len(entries) - drop > SEND_LOG_CAP:
                drop = len(entries) - SEND_LOG_CAP
            if drop:
                del entries[:drop]

    def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        with self._lock:
            return [r for r in self._logs.get(log, ()) if r.at >= since]

    def get_state(self, name: str) -> Optional[str]:
        with self._lock:
            return self._state.get(name)

    def set_state(self, name: str, value: Optional[str]) -> None:
        with self._lock:
            if value is None:
                self._state.pop(name, None)
            else:
                self._state[name] = value


class AsyncMemoryStore:
    """The in-memory store behind async methods, for :class:`~agent_email_guard.AsyncGuard`."""

    def __init__(self, store: Optional[MemoryStore] = None) -> None:
        self.sync = store or MemoryStore()

    async def increment_with_ceiling(
        self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]
    ) -> CounterResult:
        return self.sync.increment_with_ceiling(name, amount, ceiling, expires_at)

    async def decrement(self, name: str, amount: int) -> None:
        self.sync.decrement(name, amount)

    async def get_counter(self, name: str) -> int:
        return self.sync.get_counter(name)

    async def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        return self.sync.window_add(name, member, at, window_ms, ceiling)

    async def window_remove(self, name: str, member: str) -> None:
        self.sync.window_remove(name, member)

    async def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        self.sync.append_send(log, record, keep_ms)

    async def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        return self.sync.recent_sends(log, since)

    async def get_state(self, name: str) -> Optional[str]:
        return self.sync.get_state(name)

    async def set_state(self, name: str, value: Optional[str]) -> None:
        self.sync.set_state(name, value)
