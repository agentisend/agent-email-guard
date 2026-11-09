"""One conformance suite for every store: memory, Redis (fakeredis + Lua) and Postgres.

Postgres runs when AGENT_GUARD_TEST_PG is set to a connection string; the
suite creates a throwaway schema and drops it afterwards.
"""

import asyncio
import os
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent_email_guard import AsyncGuard, Guard, MemoryStore, SendRecord
from agent_email_guard.stores import AsyncMemoryStore

NOW = 1_800_000_000_000
PG = os.environ.get("AGENT_GUARD_TEST_PG")


def _record(at, to="a@x.com"):
    return SendRecord(to_line=to, recipients=(to,), subject="s", body="b", at=at)


@pytest.fixture(scope="module")
def pg_schema():
    if not PG:
        pytest.skip("set AGENT_GUARD_TEST_PG to run the Postgres store tests")
    import psycopg

    schema = "agent_guard_pytest_" + secrets.token_hex(4)
    with psycopg.connect(PG, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
    yield schema
    with psycopg.connect(PG, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def make_memory(_request):
    return MemoryStore()


def make_redis(_request):
    fakeredis = pytest.importorskip("fakeredis")
    from agent_email_guard.stores.redis import RedisStore

    return RedisStore(fakeredis.FakeRedis(), prefix=secrets.token_hex(3) + ":")


def make_pg(request):
    import psycopg

    from agent_email_guard.stores.postgres import PostgresStore

    schema = request.getfixturevalue("pg_schema")
    store = PostgresStore(psycopg.connect(PG, autocommit=True), schema=schema, table_prefix="t" + secrets.token_hex(3))
    store.setup()
    return store


STORES = [make_memory, make_redis, make_pg]


@pytest.fixture(params=STORES, ids=["memory", "redis", "postgres"])
def store(request):
    return request.param(request)


def test_increment_with_ceiling(store):
    r = store.increment_with_ceiling("c", 1, 2, NOW + 60_000)
    assert (r.ok, r.value) == (True, 1)
    r = store.increment_with_ceiling("c", 1, 2, NOW + 60_000)
    assert (r.ok, r.value) == (True, 2)
    r = store.increment_with_ceiling("c", 1, 2, NOW + 60_000)
    assert (r.ok, r.value) == (False, 2)
    r = store.increment_with_ceiling("fresh", 5, 3, None)
    assert (r.ok, r.value) == (False, 0)
    r = store.increment_with_ceiling("nolimit", 7, None, None)
    assert (r.ok, r.value) == (True, 7)
    store.decrement("c", 5)
    assert store.get_counter("c") == 0
    store.decrement("missing", 1)
    assert store.get_counter("missing") == 0


def test_window_add_slides_and_removes(store):
    r = store.window_add("w", "m1", NOW, 60_000, 2)
    assert (r.ok, r.count, r.oldest_at) == (True, 1, NOW)
    r = store.window_add("w", "m2", NOW + 10_000, 60_000, 2)
    assert (r.ok, r.count, r.oldest_at) == (True, 2, NOW)
    r = store.window_add("w", "m3", NOW + 20_000, 60_000, 2)
    assert (r.ok, r.count, r.oldest_at) == (False, 2, NOW)
    r = store.window_add("w", "m3", NOW + 60_000, 60_000, 2)  # m1 is now exactly 60s old: dropped
    assert (r.ok, r.count, r.oldest_at) == (True, 2, NOW + 10_000)
    store.window_remove("w", "m3")
    r = store.window_add("w", "m4", NOW + 60_000, 60_000, 2)
    assert r.ok and r.count == 2


def test_send_log_keeps_the_window(store):
    for i in range(5):
        store.append_send("log", _record(NOW + i * 1000), 2_500)
    recent = store.recent_sends("log", 0)
    assert [r.at for r in recent] == [NOW + 2000, NOW + 3000, NOW + 4000]
    assert store.recent_sends("log", NOW + 3000)[0] == _record(NOW + 3000)
    store.append_send("log", _record(NOW + 4000), 2_500)  # identical send, same ms: both kept
    assert len(store.recent_sends("log", NOW + 4000)) == 2


def test_state_slot(store):
    assert store.get_state("k") is None
    store.set_state("k", '{"a":1}')
    assert store.get_state("k") == '{"a":1}'
    store.set_state("k", None)
    assert store.get_state("k") is None


def test_a_guard_on_the_store_end_to_end(store):
    clock = lambda: NOW  # noqa: E731
    guard = Guard(store=store, budgets={"per_day": 2}, rate={"per_minute": 5}, approval={"new_recipients": True}, clock=clock)
    assert guard.check({"to": "a@x.com"}).reason == "recipient_requires_approval"
    d = guard.check({"to": "a@x.com"}, approved=True)
    assert d.outcome == "allow"
    guard.record({"to": "a@x.com"})
    assert guard.check({"to": "a@x.com"}).evidence["day_used"] == 2
    assert guard.check({"to": "a@x.com"}).reason == "agent_budget_exceeded"
    guard.release(d)
    assert guard.check({"to": "a@x.com"}).outcome == "allow"
    guard.kill_switch.pause("stop", by="op")
    assert guard.check({"to": "a@x.com"}).reason == "kill_switch_active"
    assert guard.kill_switch.resume("op") is True


def _race(make_store, n=40, budget=10):
    barrier = threading.Barrier(n)

    def one(i):
        guard = Guard(store=make_store(), budgets={"per_day": budget}, loop=False, clock=lambda: NOW)
        barrier.wait()
        return guard.check({"to": f"u{i}@x.com"}).outcome

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(one, range(n)))


def test_redis_race_across_clients_never_overshoots():
    fakeredis = pytest.importorskip("fakeredis")
    from agent_email_guard.stores.redis import RedisStore

    server = fakeredis.FakeServer()
    results = _race(lambda: RedisStore(fakeredis.FakeRedis(server=server)))
    assert results.count("allow") == 10


def test_postgres_race_across_connections_never_overshoots(pg_schema):
    import psycopg

    from agent_email_guard.stores.postgres import PostgresStore

    prefix = "race" + secrets.token_hex(3)
    PostgresStore(psycopg.connect(PG, autocommit=True), schema=pg_schema, table_prefix=prefix).setup()
    results = _race(lambda: PostgresStore(psycopg.connect(PG, autocommit=True), schema=pg_schema, table_prefix=prefix), n=20, budget=7)
    assert results.count("allow") == 7


def _async_flow(make_store):
    async def main():
        store = make_store()
        guard = AsyncGuard(store=store, budgets={"per_day": 3}, rate={"per_minute": 2}, clock=lambda: NOW)
        outcomes = await asyncio.gather(*(guard.check({"to": f"u{i}@x.com"}) for i in range(5)))
        await guard.record({"to": "u0@x.com"})
        await guard.kill_switch.pause("x")
        killed = await guard.check({"to": "u0@x.com"})
        return [o.reason for o in outcomes], killed.reason

    return asyncio.run(main())


def test_async_memory_store():
    reasons, killed = _async_flow(AsyncMemoryStore)
    assert sorted(reasons) == ["ok", "ok", "rate_ceiling_exceeded", "rate_ceiling_exceeded", "rate_ceiling_exceeded"]
    assert killed == "kill_switch_active"


def test_async_redis_store():
    fakeredis = pytest.importorskip("fakeredis")
    from agent_email_guard.stores.redis import AsyncRedisStore

    reasons, killed = _async_flow(lambda: AsyncRedisStore(fakeredis.FakeAsyncRedis()))
    assert reasons.count("ok") == 2 and killed == "kill_switch_active"


def test_async_postgres_store(pg_schema):
    import psycopg

    from agent_email_guard.stores.postgres import AsyncPostgresStore

    async def build():
        conn = await psycopg.AsyncConnection.connect(PG, autocommit=True)
        store = AsyncPostgresStore(conn, schema=pg_schema, table_prefix="a" + secrets.token_hex(3))
        await store.setup()
        return store

    async def main():
        store = await build()
        guard = AsyncGuard(store=store, budgets={"per_day": 3}, rate={"per_minute": 2}, clock=lambda: NOW)
        outcomes = [await guard.check({"to": f"u{i}@x.com"}) for i in range(4)]
        await guard.record({"to": "u0@x.com"})
        recent = await store.recent_sends("agent-email-guard:default:log", 0)
        return [o.reason for o in outcomes], len(recent)

    reasons, logged = asyncio.run(main())
    assert reasons == ["ok", "ok", "rate_ceiling_exceeded", "rate_ceiling_exceeded"]
    assert logged == 1
