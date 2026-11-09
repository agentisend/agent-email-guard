"""Postgres store (psycopg 3): share budgets, the rate window, the loop log and the kill switch across processes.

``pip install "agent-email-guard[postgres]"``::

    import psycopg
    from agent_email_guard import Guard
    from agent_email_guard.stores.postgres import PostgresStore

    store = PostgresStore(psycopg.connect("postgresql://localhost/app", autocommit=True))
    store.setup()  # CREATE TABLE IF NOT EXISTS, once
    guard = Guard(budgets={"per_day": 500}, store=store)

Pass a ``psycopg.Connection`` or a ``psycopg_pool.ConnectionPool``.
``increment_with_ceiling`` is one conditional upsert; ``window_add`` runs in a
transaction holding an advisory lock on the window name. Use
:class:`AsyncPostgresStore` with ``psycopg.AsyncConnection`` (or an async pool).
"""

from __future__ import annotations

import contextlib
import json
import re
from typing import Any, AsyncIterator, Iterator, List, Optional

from ..loop import SendRecord
from .base import SEND_LOG_CAP, CounterResult, WindowResult

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _sql(schema: Optional[str], prefix: str) -> dict:
    if schema is not None and not _IDENT.match(schema):
        raise ValueError("schema must be a plain SQL identifier.")
    if not _IDENT.match(prefix):
        raise ValueError("table_prefix must be a plain SQL identifier.")
    q = f'"{schema}".' if schema else ""
    c, w, s, st = (f"{q}{prefix}_{t}" for t in ("counters", "windows", "sends", "state"))
    return {
        "setup": [
            f"CREATE TABLE IF NOT EXISTS {c} (name text PRIMARY KEY, value bigint NOT NULL, expires_at bigint)",
            f"CREATE TABLE IF NOT EXISTS {w} (name text NOT NULL, member text NOT NULL, at bigint NOT NULL, PRIMARY KEY (name, member))",
            f"CREATE TABLE IF NOT EXISTS {s} (id bigserial PRIMARY KEY, log text NOT NULL, at bigint NOT NULL, record jsonb NOT NULL)",
            f"CREATE INDEX IF NOT EXISTS {prefix}_sends_log_at ON {s} (log, at)",
            f"CREATE TABLE IF NOT EXISTS {st} (name text PRIMARY KEY, value text NOT NULL)",
        ],
        "increment": (
            f"INSERT INTO {c} AS c (name, value, expires_at) "
            "SELECT %(name)s, %(amount)s, %(expires_at)s "
            "WHERE %(ceiling)s::bigint IS NULL OR %(amount)s::bigint <= %(ceiling)s::bigint "
            "ON CONFLICT (name) DO UPDATE SET value = c.value + EXCLUDED.value, expires_at = EXCLUDED.expires_at "
            "WHERE %(ceiling)s::bigint IS NULL OR c.value + EXCLUDED.value <= %(ceiling)s::bigint "
            "RETURNING value"
        ),
        "counter": f"SELECT value FROM {c} WHERE name = %s",
        "decrement": f"UPDATE {c} SET value = GREATEST(0, value - %s) WHERE name = %s",
        "purge": f"DELETE FROM {c} WHERE expires_at IS NOT NULL AND expires_at <= %s",
        "lock": "SELECT pg_advisory_xact_lock(hashtext(%s))",
        "window_trim": f"DELETE FROM {w} WHERE name = %s AND at <= %s",
        "window_stat": f"SELECT count(*), min(at) FROM {w} WHERE name = %s",
        "window_insert": f"INSERT INTO {w} (name, member, at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
        "window_remove": f"DELETE FROM {w} WHERE name = %s AND member = %s",
        "send_insert": f"INSERT INTO {s} (log, at, record) VALUES (%s, %s, %s::jsonb)",
        "send_trim": f"DELETE FROM {s} WHERE log = %s AND at < %s",
        "send_cap": (
            f"DELETE FROM {s} WHERE id IN (SELECT id FROM {s} WHERE log = %s ORDER BY at DESC, id DESC OFFSET %s)"
        ),
        "send_recent": f"SELECT record FROM {s} WHERE log = %s AND at >= %s ORDER BY at, id",
        "state_get": f"SELECT value FROM {st} WHERE name = %s",
        "state_set": f"INSERT INTO {st} (name, value) VALUES (%s, %s) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value",
        "state_del": f"DELETE FROM {st} WHERE name = %s",
    }


def _record(raw: Any) -> SendRecord:
    return SendRecord.from_dict(json.loads(raw) if isinstance(raw, (str, bytes)) else raw)


def _dump(record: SendRecord) -> str:
    return json.dumps(record.to_dict(), separators=(",", ":"), ensure_ascii=False)


class PostgresStore:
    """Sync store. ``schema`` and ``table_prefix`` (default ``agent_email_guard``) name the tables."""

    def __init__(self, conn: Any, *, schema: Optional[str] = None, table_prefix: str = "agent_email_guard") -> None:
        self._source = conn
        self._q = _sql(schema, table_prefix)

    @contextlib.contextmanager
    def _tx(self) -> Iterator[Any]:
        if hasattr(self._source, "connection") and not hasattr(self._source, "execute"):
            with self._source.connection() as conn:
                with conn.transaction():
                    yield conn
        else:
            with self._source.transaction():
                yield self._source

    def setup(self) -> None:
        """Create the four tables and the index if they do not exist."""
        with self._tx() as conn:
            for stmt in self._q["setup"]:
                conn.execute(stmt)

    def purge_expired(self, now_ms: int) -> int:
        """Delete counters whose period ended. Housekeeping; never required for correctness."""
        with self._tx() as conn:
            return conn.execute(self._q["purge"], (now_ms,)).rowcount

    def increment_with_ceiling(self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]) -> CounterResult:
        with self._tx() as conn:
            row = conn.execute(
                self._q["increment"], {"name": name, "amount": amount, "ceiling": ceiling, "expires_at": expires_at}
            ).fetchone()
            if row is not None:
                return CounterResult(True, int(row[0]))
            current = conn.execute(self._q["counter"], (name,)).fetchone()
            return CounterResult(False, int(current[0]) if current else 0)

    def decrement(self, name: str, amount: int) -> None:
        with self._tx() as conn:
            conn.execute(self._q["decrement"], (amount, name))

    def get_counter(self, name: str) -> int:
        with self._tx() as conn:
            row = conn.execute(self._q["counter"], (name,)).fetchone()
            return int(row[0]) if row else 0

    def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        with self._tx() as conn:
            conn.execute(self._q["lock"], (name,))
            conn.execute(self._q["window_trim"], (name, at - window_ms))
            count, oldest = conn.execute(self._q["window_stat"], (name,)).fetchone()
            count = int(count)
            if count >= ceiling:
                return WindowResult(False, count, int(oldest) if oldest is not None else None)
            conn.execute(self._q["window_insert"], (name, member, at))
            return WindowResult(True, count + 1, int(oldest) if oldest is not None else at)

    def window_remove(self, name: str, member: str) -> None:
        with self._tx() as conn:
            conn.execute(self._q["window_remove"], (name, member))

    def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        with self._tx() as conn:
            conn.execute(self._q["send_insert"], (log, record.at, _dump(record)))
            conn.execute(self._q["send_trim"], (log, record.at - keep_ms))
            conn.execute(self._q["send_cap"], (log, SEND_LOG_CAP))

    def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        with self._tx() as conn:
            return [_record(r[0]) for r in conn.execute(self._q["send_recent"], (log, since)).fetchall()]

    def get_state(self, name: str) -> Optional[str]:
        with self._tx() as conn:
            row = conn.execute(self._q["state_get"], (name,)).fetchone()
            return row[0] if row else None

    def set_state(self, name: str, value: Optional[str]) -> None:
        with self._tx() as conn:
            if value is None:
                conn.execute(self._q["state_del"], (name,))
            else:
                conn.execute(self._q["state_set"], (name, value))


class AsyncPostgresStore:
    """Async store over ``psycopg.AsyncConnection`` or ``psycopg_pool.AsyncConnectionPool``."""

    def __init__(self, conn: Any, *, schema: Optional[str] = None, table_prefix: str = "agent_email_guard") -> None:
        self._source = conn
        self._q = _sql(schema, table_prefix)

    @contextlib.asynccontextmanager
    async def _tx(self) -> AsyncIterator[Any]:
        if hasattr(self._source, "connection") and not hasattr(self._source, "execute"):
            async with self._source.connection() as conn:
                async with conn.transaction():
                    yield conn
        else:
            async with self._source.transaction():
                yield self._source

    async def setup(self) -> None:
        async with self._tx() as conn:
            for stmt in self._q["setup"]:
                await conn.execute(stmt)

    async def purge_expired(self, now_ms: int) -> int:
        async with self._tx() as conn:
            return (await conn.execute(self._q["purge"], (now_ms,))).rowcount

    async def increment_with_ceiling(self, name: str, amount: int, ceiling: Optional[int], expires_at: Optional[int]) -> CounterResult:
        async with self._tx() as conn:
            cur = await conn.execute(
                self._q["increment"], {"name": name, "amount": amount, "ceiling": ceiling, "expires_at": expires_at}
            )
            row = await cur.fetchone()
            if row is not None:
                return CounterResult(True, int(row[0]))
            current = await (await conn.execute(self._q["counter"], (name,))).fetchone()
            return CounterResult(False, int(current[0]) if current else 0)

    async def decrement(self, name: str, amount: int) -> None:
        async with self._tx() as conn:
            await conn.execute(self._q["decrement"], (amount, name))

    async def get_counter(self, name: str) -> int:
        async with self._tx() as conn:
            row = await (await conn.execute(self._q["counter"], (name,))).fetchone()
            return int(row[0]) if row else 0

    async def window_add(self, name: str, member: str, at: int, window_ms: int, ceiling: int) -> WindowResult:
        async with self._tx() as conn:
            await conn.execute(self._q["lock"], (name,))
            await conn.execute(self._q["window_trim"], (name, at - window_ms))
            count, oldest = await (await conn.execute(self._q["window_stat"], (name,))).fetchone()
            count = int(count)
            if count >= ceiling:
                return WindowResult(False, count, int(oldest) if oldest is not None else None)
            await conn.execute(self._q["window_insert"], (name, member, at))
            return WindowResult(True, count + 1, int(oldest) if oldest is not None else at)

    async def window_remove(self, name: str, member: str) -> None:
        async with self._tx() as conn:
            await conn.execute(self._q["window_remove"], (name, member))

    async def append_send(self, log: str, record: SendRecord, keep_ms: int) -> None:
        async with self._tx() as conn:
            await conn.execute(self._q["send_insert"], (log, record.at, _dump(record)))
            await conn.execute(self._q["send_trim"], (log, record.at - keep_ms))
            await conn.execute(self._q["send_cap"], (log, SEND_LOG_CAP))

    async def recent_sends(self, log: str, since: int) -> List[SendRecord]:
        async with self._tx() as conn:
            rows = await (await conn.execute(self._q["send_recent"], (log, since))).fetchall()
            return [_record(r[0]) for r in rows]

    async def get_state(self, name: str) -> Optional[str]:
        async with self._tx() as conn:
            row = await (await conn.execute(self._q["state_get"], (name,))).fetchone()
            return row[0] if row else None

    async def set_state(self, name: str, value: Optional[str]) -> None:
        async with self._tx() as conn:
            if value is None:
                await conn.execute(self._q["state_del"], (name,))
            else:
                await conn.execute(self._q["state_set"], (name, value))
