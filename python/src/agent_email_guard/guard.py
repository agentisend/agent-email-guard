"""The guard: budgets, a rate ceiling, loop detection, approvals and a kill switch in front of any send.

``check()`` runs, in this order, stopping at the first block:

1. kill switch          refuse  kill_switch_active
2. suppression list     refuse  recipient_suppressed
3. loop detection       refuse  loop_repetition_detected | recipient_entropy_collapse
4. approval rules       hold    recipient_requires_approval   (skipped when approved)
5. rate ceiling         refuse  rate_ceiling_exceeded         (reserves a slot)
6. budgets hour->month  refuse  agent_budget_exceeded         (reserves one each)
7. allow                        ok

Nothing before step 5 reserves anything, so a refusal or a hold never needs
undoing; a budget refusal at step 6 gives back what steps 5-6 reserved.

The pipeline is written once, as a generator that yields the store calls it
needs. :class:`Guard` drives it against a sync store, :class:`AsyncGuard`
against an async one, so both decide identically.
"""

from __future__ import annotations

import functools
import inspect
import itertools
import json
import math
import secrets
import time
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Generator, List, Mapping, Optional, Sequence, Tuple, TypeVar, Union, cast

from . import messages
from .decisions import Decision, Evidence, Reservation
from .errors import ApprovalRequired, GuardRefused
from .loop import SendRecord, detect_loop, resolve_loop_config, to_record
from .stores.base import AsyncStore, Store
from .stores.memory import AsyncMemoryStore, MemoryStore
from .text import address_list, normalize_address

F = TypeVar("F", bound=Callable[..., Any])

DEFAULT_KEY = "default"
DEFAULT_NAMESPACE = "agent-email-guard"
MINUTE = 60_000
HOUR = 3_600_000
DAY = 86_400_000
#: Config name -> period name used in store keys, evidence and sentences.
BUDGET_PERIODS = (("per_hour", "hour"), ("per_day", "day"), ("per_month", "month"))


def period_bounds(period: str, now: int) -> Tuple[int, int]:
    """[start, end) of the UTC calendar period (hour, day or month) containing ``now``."""
    if period == "hour":
        start = now // HOUR * HOUR
        return start, start + HOUR
    if period == "day":
        start = now // DAY * DAY
        return start, start + DAY
    d = datetime.fromtimestamp(now // 1000, tz=timezone.utc)
    start_dt = datetime(d.year, d.month, 1, tzinfo=timezone.utc)
    end_dt = datetime(d.year + (d.month == 12), d.month % 12 + 1, 1, tzinfo=timezone.utc)
    return int(start_dt.timestamp()) * 1000, int(end_dt.timestamp()) * 1000


def _field(send: Any, name: str) -> Any:
    if isinstance(send, Mapping):
        return send.get(name)
    return getattr(send, name, None)


def _first_rule_match(addresses: Sequence[str], rules: Sequence[str]) -> Optional[Tuple[str, str]]:
    for a in addresses:
        for rule in rules:
            r = normalize_address(rule)
            if (r.startswith("@") and a.endswith(r)) or a == r:
                return a, r  # SPEC 3.3: report the normalized rule
    return None


_member_counter = itertools.count(1)


def _new_member(now: int) -> str:
    return f"{now}-{next(_member_counter) % 1_000_000_000}-{secrets.token_hex(4)}"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass
class _Config:
    key: str
    namespace: str
    budgets: List[Tuple[str, int]]  # (period, budget) hour -> month
    per_minute: Optional[int]
    loop: Dict[str, Any]
    new_recipients: bool
    approval_recipients: List[str]
    require_for: Optional[Callable[[Any], Any]]
    suppress: List[str]


def _parse_config(
    key: Optional[str],
    budgets: Optional[Mapping[str, Optional[int]]],
    rate: Optional[Mapping[str, Optional[int]]],
    loop: Union[None, bool, Mapping[str, Any]],
    approval: Optional[Mapping[str, Any]],
    suppress: Optional[Sequence[str]],
    namespace: Optional[str],
) -> _Config:
    budgets = dict(budgets or {})
    unknown = set(budgets) - {name for name, _ in BUDGET_PERIODS}
    if unknown:
        raise ValueError(f"budgets accepts per_hour, per_day and per_month; got {sorted(unknown)!r}.")
    parsed: List[Tuple[str, int]] = []
    for name, period in BUDGET_PERIODS:
        value = budgets.get(name)
        if value is not None:
            if int(value) < 0:
                raise ValueError(f"budgets.{name} must be 0 or more.")
            parsed.append((period, int(value)))
    rate = dict(rate or {})
    if set(rate) - {"per_minute"}:
        raise ValueError(f"rate accepts per_minute only; got {sorted(set(rate) - {'per_minute'})!r}.")
    per_minute = rate.get("per_minute")
    if per_minute is not None and int(per_minute) < 0:
        raise ValueError("rate.per_minute must be 0 or more.")
    if loop is False:
        loop_cfg = resolve_loop_config({"mode": "off"})
    elif loop is None or loop is True:
        loop_cfg = resolve_loop_config(None)
    else:
        loop_cfg = resolve_loop_config(loop)
    approval = dict(approval or {})
    unknown = set(approval) - {"new_recipients", "recipients", "require_for"}
    if unknown:
        raise ValueError(f"approval accepts new_recipients, recipients and require_for; got {sorted(unknown)!r}.")
    return _Config(
        key=key or DEFAULT_KEY,
        namespace=namespace or DEFAULT_NAMESPACE,
        budgets=parsed,
        per_minute=int(per_minute) if per_minute is not None else None,
        loop=loop_cfg,
        new_recipients=bool(approval.get("new_recipients", False)),
        approval_recipients=list(approval.get("recipients") or ()),
        require_for=approval.get("require_for"),
        suppress=list(suppress or ()),
    )


# ---------------------------------------------------------------------------
# The pipeline, written once
# ---------------------------------------------------------------------------

_Op = Tuple[str, Tuple[Any, ...]]
_Pipeline = Generator[_Op, Any, Any]
_AWAIT = "__await__"  # pseudo-op: resolve an awaitable (async require_for)


class _Names:
    def __init__(self, ns: str) -> None:
        self.ns = ns
        self.kill = f"{ns}:kill"
        self.last_resume = f"{ns}:kill:last_resume"

    def log(self, key: str) -> str:
        return f"{self.ns}:{key}:log"

    def seen(self, key: str, address: str) -> str:
        return f"{self.ns}:{key}:seen:{address}"

    def rate(self, key: str) -> str:
        return f"{self.ns}:{key}:rate"

    def budget(self, key: str, period: str, start: int) -> str:
        return f"{self.ns}:{key}:budget:{period}:{start}"


@dataclass(frozen=True)
class KillSwitchState:
    paused: bool
    paused_at: Optional[int] = None
    paused_by: Optional[str] = None
    reason: Optional[str] = None


def _parse_kill(raw: Optional[str]) -> KillSwitchState:
    if raw is None:
        return KillSwitchState(False)
    data = json.loads(raw)
    return KillSwitchState(True, data.get("paused_at"), data.get("paused_by"), data.get("reason"))


def _resume_record(raw: str, by: str, at: int) -> str:
    """SPEC 2.8 / 6.3: exactly these five keys, overwriting the previous record."""
    pause = json.loads(raw)
    return json.dumps(
        {
            "paused_at": pause.get("paused_at"),
            "paused_by": pause.get("paused_by"),
            "reason": pause.get("reason"),
            "resumed_at": at,
            "resumed_by": by,
        }
    )


def _key_of(cfg: _Config, send: Any) -> str:
    key = _field(send, "key")
    return str(key) if key is not None else cfg.key


def _check(cfg: _Config, names: _Names, send: Any, now: int, approved: bool) -> _Pipeline:
    key = _key_of(cfg, send)

    # 1. Kill switch.
    kill = _parse_kill((yield ("get_state", (names.kill,))))
    if kill.paused:
        return Decision(
            "refuse",
            "kill_switch_active",
            messages.kill_switch_active(),
            {"paused_at": kill.paused_at, "paused_by": kill.paused_by, "pause_reason": kill.reason},
        )

    candidate = to_record(send, at=now)

    # 2. Suppression.
    hit = _first_rule_match(candidate.recipients, cfg.suppress)
    if hit:
        return Decision(
            "refuse",
            "recipient_suppressed",
            messages.recipient_suppressed(hit[0], hit[1]),
            {"recipient": hit[0], "matched_rule": hit[1]},
        )

    # 3. Loop detection.
    evidence: Evidence = {"key": key}
    if cfg.loop["mode"] != "off":
        recent = yield ("recent_sends", (names.log(key), now - cfg.loop["window_ms"]))
        loop = detect_loop(recent, candidate, now, cfg.loop)
        if loop.decision is not None:
            return loop.decision
        evidence.update(loop.stats)

    # 4. Approval.
    if approved:
        evidence["approved"] = True
    else:
        hit = _first_rule_match(candidate.recipients, cfg.approval_recipients)
        if hit:
            return Decision(
                "hold_for_approval",
                "recipient_requires_approval",
                messages.approval_recipient_rule(hit[0], hit[1]),
                {"rule": "recipient_list", "recipient": hit[0], "matched_rule": hit[1]},
            )
        if cfg.require_for is not None:
            verdict = cfg.require_for(send)
            if inspect.isawaitable(verdict):
                verdict = yield (_AWAIT, (verdict,))
            if verdict:
                return Decision(
                    "hold_for_approval",
                    "recipient_requires_approval",
                    messages.approval_custom(),
                    {"rule": "custom", "detail": verdict if isinstance(verdict, str) else None},
                )
        if cfg.new_recipients:
            unseen: List[str] = []
            for a in candidate.recipients:
                if (yield ("get_counter", (names.seen(key, a),))) == 0:
                    unseen.append(a)
            if unseen:
                return Decision(
                    "hold_for_approval",
                    "recipient_requires_approval",
                    messages.approval_new_recipient(unseen[0], key),
                    {"rule": "new_recipient", "recipient": unseen[0], "new_recipients": ",".join(unseen)},
                )

    # 5. Rate ceiling: reserves a slot in the sliding minute.
    counters: List[Tuple[str, int]] = []
    window: Optional[Tuple[str, str]] = None
    if cfg.per_minute is not None:
        name = names.rate(key)
        member = _new_member(now)
        res = yield ("window_add", (name, member, now, MINUTE, cfg.per_minute))
        if not res.ok:
            retry = 60 if res.oldest_at is None else max(1, math.ceil((res.oldest_at + MINUTE - now) / 1000))
            return Decision(
                "refuse",
                "rate_ceiling_exceeded",
                messages.rate_ceiling_exceeded(key, cfg.per_minute, retry),
                {
                    "key": key,
                    "sends_in_window": res.count,
                    "ceiling_per_minute": cfg.per_minute,
                    "retry_after_seconds": retry,
                },
            )
        window = (name, member)
        evidence["rate_used"] = res.count
        evidence["rate_ceiling"] = cfg.per_minute

    # 6. Budgets, hour -> day -> month, one atomic increment each.
    for period, budget in cfg.budgets:
        start, end = period_bounds(period, now)
        name = names.budget(key, period, start)
        res = yield ("increment_with_ceiling", (name, 1, budget, end))
        if not res.ok:
            yield from _give_back(Reservation(key, tuple(counters), window))
            return Decision(
                "refuse",
                "agent_budget_exceeded",
                messages.agent_budget_exceeded(key, period, budget, end),
                {"key": key, "period": period, "budget": budget, "used": res.value, "resets_at": end},
            )
        counters.append((name, 1))
        evidence[f"{period}_used"] = res.value
        evidence[f"{period}_budget"] = budget

    reservation = Reservation(key, tuple(counters), window) if counters or window else None
    return Decision("allow", "ok", messages.ok(), evidence, reservation)


def _give_back(r: Reservation) -> _Pipeline:
    for name, amount in r.counters:
        yield ("decrement", (name, amount))
    if r.window:
        yield ("window_remove", r.window)


def _record(cfg: _Config, names: _Names, send: Any, now: int) -> _Pipeline:
    key = _key_of(cfg, send)
    rec = to_record(send, at=now)
    yield ("append_send", (names.log(key), rec, cfg.loop["window_ms"]))
    for a in rec.recipients:
        yield ("increment_with_ceiling", (names.seen(key, a), 1, None, None))


def _run_sync(store: Any, gen: _Pipeline) -> Any:
    try:
        op = next(gen)
        while True:
            name, args = op
            if name == _AWAIT:
                close = getattr(args[0], "close", None)
                if close is not None:
                    close()
                raise TypeError("require_for returned an awaitable; use AsyncGuard for async rules.")
            op = gen.send(getattr(store, name)(*args))
    except StopIteration as stop:
        return stop.value


async def _run_async(store: Any, gen: _Pipeline) -> Any:
    try:
        op = next(gen)
        while True:
            name, args = op
            result = await args[0] if name == _AWAIT else await getattr(store, name)(*args)
            op = gen.send(result)
    except StopIteration as stop:
        return stop.value


def _default_clock() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Kill switch handles
# ---------------------------------------------------------------------------


class KillSwitch:
    """Stops every send through this guard (every key) until ``resume()``. Never resumes on its own."""

    def __init__(self, store: Store, names: _Names, clock: Callable[[], int]) -> None:
        self._store, self._names, self._clock = store, names, clock

    def pause(self, reason: str, by: str = "agent-email-guard") -> KillSwitchState:
        at = self._clock()
        self._store.set_state(self._names.kill, json.dumps({"paused_at": at, "paused_by": by, "reason": reason}))
        return KillSwitchState(True, at, by, reason)

    def resume(self, by: str) -> bool:
        """Clear the pause and return True; return False, recording nothing, when it was not paused.

        The cleared pause is kept, with who resumed it and when, under ``<namespace>:kill:last_resume``.
        """
        raw = self._store.get_state(self._names.kill)
        if raw is None:
            return False
        self._store.set_state(self._names.last_resume, _resume_record(raw, by, self._clock()))
        self._store.set_state(self._names.kill, None)
        return True

    def state(self) -> KillSwitchState:
        return _parse_kill(self._store.get_state(self._names.kill))


class AsyncKillSwitch:
    def __init__(self, store: AsyncStore, names: _Names, clock: Callable[[], int]) -> None:
        self._store, self._names, self._clock = store, names, clock

    async def pause(self, reason: str, by: str = "agent-email-guard") -> KillSwitchState:
        at = self._clock()
        await self._store.set_state(self._names.kill, json.dumps({"paused_at": at, "paused_by": by, "reason": reason}))
        return KillSwitchState(True, at, by, reason)

    async def resume(self, by: str) -> bool:
        raw = await self._store.get_state(self._names.kill)
        if raw is None:
            return False
        await self._store.set_state(self._names.last_resume, _resume_record(raw, by, self._clock()))
        await self._store.set_state(self._names.kill, None)
        return True

    async def state(self) -> KillSwitchState:
        return _parse_kill(await self._store.get_state(self._names.kill))


# ---------------------------------------------------------------------------
# Public guards
# ---------------------------------------------------------------------------


class _Base:
    def __init__(
        self,
        *,
        key: Optional[str] = None,
        budgets: Optional[Mapping[str, Optional[int]]] = None,
        rate: Optional[Mapping[str, Optional[int]]] = None,
        loop: Union[None, bool, Mapping[str, Any]] = None,
        approval: Optional[Mapping[str, Any]] = None,
        suppress: Optional[Sequence[str]] = None,
        clock: Optional[Callable[[], int]] = None,
        namespace: Optional[str] = None,
    ) -> None:
        self._cfg = _parse_config(key, budgets, rate, loop, approval, suppress, namespace)
        self._names = _Names(self._cfg.namespace)
        self._clock = clock or _default_clock
        self._released: "weakref.WeakSet[Reservation]" = weakref.WeakSet()

    def _take_release(self, decision: Decision) -> Optional[Reservation]:
        r = decision.reservation
        if r is None or r in self._released:
            return None
        self._released.add(r)
        return r


def _default_extract(args: Tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if args:
        return args[0]
    if "to" in kwargs:
        return kwargs
    raise TypeError("agent-email-guard could not find the email in this call; pass extract=lambda *a, **kw: {...} to wrap().")


def _policy_config(path: Any, require_for: Any, overrides: Dict[str, Any]) -> Dict[str, Any]:
    from .policy import load_policy

    config = load_policy(path)
    if require_for is not None:
        approval = dict(config.get("approval") or {})
        approval["require_for"] = require_for
        config["approval"] = approval
    config.update(overrides)
    return config


class Guard(_Base):
    """Synchronous guard.

    ``check()`` before the send, ``record()`` after the provider accepted it,
    ``release()`` if the provider failed. ``wrap()`` does all three.
    """

    def __init__(self, *, store: Optional[Store] = None, **config: Any) -> None:
        super().__init__(**config)
        self.store: Store = store if store is not None else MemoryStore()
        self.kill_switch = KillSwitch(self.store, self._names, self._clock)

    @classmethod
    def from_policy(cls, path: Any = None, *, require_for: Optional[Callable[[Any], Any]] = None, **overrides: Any) -> "Guard":
        """Build a guard from ``agent-email-guard.json`` (or ``path``); keyword arguments override the file."""
        return cls(**_policy_config(path, require_for, overrides))

    def check(self, send: Any, *, approved: bool = False) -> Decision:
        """Decide allow / hold_for_approval / refuse. An allow has already reserved rate and budget."""
        return cast(Decision, _run_sync(self.store, _check(self._cfg, self._names, send, self._clock(), approved)))

    def record(self, send: Any) -> None:
        """The provider accepted the send: feed loop detection and the new-recipient memory."""
        _run_sync(self.store, _record(self._cfg, self._names, send, self._clock()))

    def release(self, decision: Decision) -> None:
        """The provider failed: give back what ``check()`` reserved. Safe to call twice."""
        r = self._take_release(decision)
        if r is not None:
            _run_sync(self.store, _give_back(r))

    def wrap(self, fn: F, *, extract: Optional[Callable[..., Any]] = None) -> F:
        """Return ``fn`` with the same signature that checks, sends and records.

        Raises :class:`GuardRefused` or :class:`ApprovalRequired`; nothing is
        sent in either case. ``ApprovalRequired.approve()`` re-runs every other
        check and sends, for when a person approved.
        """
        if inspect.iscoroutinefunction(fn):
            raise TypeError("wrap() got an async function; use AsyncGuard for asyncio code.")
        guard = self

        def run(approved: bool, args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
            send = extract(*args, **kwargs) if extract else _default_extract(args, kwargs)
            decision = guard.check(send, approved=approved)
            if decision.outcome == "refuse":
                raise GuardRefused(decision)
            if decision.outcome == "hold_for_approval":
                raise ApprovalRequired(decision, lambda: run(True, args, kwargs))
            try:
                result = fn(*args, **kwargs)
            except BaseException:
                guard.release(decision)
                raise
            guard.record(send)
            return result

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return run(False, args, kwargs)

        return cast(F, wrapper)


class AsyncGuard(_Base):
    """The same guard for asyncio agents. ``require_for`` may be async here."""

    def __init__(self, *, store: Optional[AsyncStore] = None, **config: Any) -> None:
        super().__init__(**config)
        self.store: AsyncStore = store if store is not None else AsyncMemoryStore()
        self.kill_switch = AsyncKillSwitch(self.store, self._names, self._clock)

    @classmethod
    def from_policy(cls, path: Any = None, *, require_for: Optional[Callable[[Any], Any]] = None, **overrides: Any) -> "AsyncGuard":
        return cls(**_policy_config(path, require_for, overrides))

    async def check(self, send: Any, *, approved: bool = False) -> Decision:
        return cast(
            Decision, await _run_async(self.store, _check(self._cfg, self._names, send, self._clock(), approved))
        )

    async def record(self, send: Any) -> None:
        await _run_async(self.store, _record(self._cfg, self._names, send, self._clock()))

    async def release(self, decision: Decision) -> None:
        r = self._take_release(decision)
        if r is not None:
            await _run_async(self.store, _give_back(r))

    def wrap(self, fn: Callable[..., Awaitable[Any]], *, extract: Optional[Callable[..., Any]] = None) -> Any:
        if not inspect.iscoroutinefunction(fn):
            raise TypeError("AsyncGuard.wrap() needs an async function; use Guard.wrap() for sync code.")
        guard = self

        async def run(approved: bool, args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
            send = extract(*args, **kwargs) if extract else _default_extract(args, kwargs)
            decision = await guard.check(send, approved=approved)
            if decision.outcome == "refuse":
                raise GuardRefused(decision)
            if decision.outcome == "hold_for_approval":
                raise ApprovalRequired(decision, lambda: run(True, args, kwargs))
            try:
                result = await fn(*args, **kwargs)
            except BaseException:
                await guard.release(decision)
                raise
            await guard.record(send)
            return result

        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            return await run(False, args, kwargs)

        return wrapper


def create_guard(**config: Any) -> Guard:
    """``create_guard(budgets=..., rate=..., loop=..., approval=..., suppress=..., store=...)``."""
    return Guard(**config)


__all__ = [
    "AsyncGuard",
    "AsyncKillSwitch",
    "Guard",
    "KillSwitch",
    "KillSwitchState",
    "SendRecord",
    "create_guard",
    "period_bounds",
]
