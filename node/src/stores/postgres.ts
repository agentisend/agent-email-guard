/**
 * Postgres store (SPEC §6). Shared by every process that uses the same
 * database and namespace.
 *
 * Budgets are one conditional INSERT … ON CONFLICT DO UPDATE … WHERE, which
 * Postgres applies atomically per row. The rate window needs a count and an
 * insert to agree, so it runs in a transaction under a transaction-scoped
 * advisory lock on the window name.
 *
 * Pass a `pg` Pool (recommended: transactions get their own connection), a
 * `pg` Client, or anything with `query(text, params)` returning `{ rows }`
 * (PGlite works). With a single connection, transactions are serialized in
 * this process.
 */

import { SEND_LOG_CAP, type CounterResult, type GuardStore, type SendRecord, type WindowResult } from '../store.js';

export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(): void }>;
}

export interface PostgresStoreOptions {
  /** Table name prefix. Default "agent_email_guard". Letters, digits and underscores only. */
  readonly tablePrefix?: string;
}

/** DDL for the four tables. Run once (migrate()), or copy it into your migrations. */
export function postgresSchema(prefix = 'agent_email_guard'): string {
  assertIdentifier(prefix);
  return `
CREATE TABLE IF NOT EXISTS ${prefix}_counters (
  name text PRIMARY KEY,
  value bigint NOT NULL,
  expires_at bigint NULL
);
CREATE TABLE IF NOT EXISTS ${prefix}_windows (
  name text NOT NULL,
  member text NOT NULL,
  at bigint NOT NULL,
  PRIMARY KEY (name, member)
);
CREATE TABLE IF NOT EXISTS ${prefix}_sends (
  id bigserial PRIMARY KEY,
  log text NOT NULL,
  at bigint NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ${prefix}_sends_log_at ON ${prefix}_sends (log, at);
CREATE TABLE IF NOT EXISTS ${prefix}_state (
  name text PRIMARY KEY,
  value text NOT NULL
);`;
}

function assertIdentifier(s: string): void {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(s)) throw new TypeError(`tablePrefix must match [a-z_][a-z0-9_]*: got "${s}"`);
}

export class PostgresStore implements GuardStore {
  readonly #db: PgQueryable | PgPoolLike;
  readonly #t: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: PgQueryable | PgPoolLike, options: PostgresStoreOptions = {}) {
    this.#db = db;
    this.#t = options.tablePrefix ?? 'agent_email_guard';
    assertIdentifier(this.#t);
  }

  /** Create the tables if they do not exist. */
  async migrate(): Promise<void> {
    for (const stmt of postgresSchema(this.#t).split(';').map((s) => s.trim()).filter(Boolean)) {
      await this.#db.query(stmt);
    }
  }

  /** Delete expired counters and empty windows. Call from a cron if you like; correctness never depends on it. */
  async sweep(now = Date.now()): Promise<void> {
    await this.#db.query(`DELETE FROM ${this.#t}_counters WHERE expires_at IS NOT NULL AND expires_at < $1`, [now]);
  }

  async #transaction<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    if ('connect' in this.#db && typeof this.#db.connect === 'function') {
      const client = await this.#db.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    // One shared connection: serialize transactions in this process.
    const run = this.#queue.then(async () => {
      const db = this.#db;
      await db.query('BEGIN');
      try {
        const out = await fn(db);
        await db.query('COMMIT');
        return out;
      } catch (err) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #query(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    // Wait for any serialized transaction on a shared connection to finish.
    if (!('connect' in this.#db)) await this.#queue;
    return (await this.#db.query(text, params)).rows;
  }

  async incrementWithCeiling(name: string, amount: number, ceiling: number | null, expiresAt: number | null): Promise<CounterResult> {
    const rows = await this.#query(
      `INSERT INTO ${this.#t}_counters AS c (name, value, expires_at)
       SELECT $1::text, $2::bigint, $4::bigint WHERE $3::bigint IS NULL OR $2::bigint <= $3::bigint
       ON CONFLICT (name) DO UPDATE SET value = c.value + EXCLUDED.value, expires_at = COALESCE(EXCLUDED.expires_at, c.expires_at)
       WHERE $3::bigint IS NULL OR c.value + EXCLUDED.value <= $3::bigint
       RETURNING value`,
      [name, amount, ceiling, expiresAt],
    );
    if (rows.length > 0) return { ok: true, value: Number(rows[0]?.value) };
    return { ok: false, value: await this.getCounter(name) };
  }

  async decrement(name: string, amount: number): Promise<void> {
    await this.#query(`UPDATE ${this.#t}_counters SET value = GREATEST(0, value - $2::bigint) WHERE name = $1`, [name, amount]);
  }

  async getCounter(name: string): Promise<number> {
    const rows = await this.#query(`SELECT value FROM ${this.#t}_counters WHERE name = $1`, [name]);
    return rows.length > 0 ? Number(rows[0]?.value) : 0;
  }

  async windowAdd(name: string, member: string, at: number, windowMs: number, ceiling: number): Promise<WindowResult> {
    return this.#transaction(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
      await q.query(`DELETE FROM ${this.#t}_windows WHERE name = $1 AND at <= $2::bigint`, [name, at - windowMs]);
      const { rows } = await q.query(`SELECT count(*)::int AS n, min(at) AS oldest FROM ${this.#t}_windows WHERE name = $1`, [name]);
      const count = Number(rows[0]?.n ?? 0);
      const oldest = rows[0]?.oldest === null || rows[0]?.oldest === undefined ? null : Number(rows[0].oldest);
      if (count >= ceiling) return { ok: false, count, oldestAt: oldest };
      await q.query(`INSERT INTO ${this.#t}_windows (name, member, at) VALUES ($1, $2, $3)`, [name, member, at]);
      return { ok: true, count: count + 1, oldestAt: oldest ?? at };
    });
  }

  async windowRemove(name: string, member: string): Promise<void> {
    await this.#query(`DELETE FROM ${this.#t}_windows WHERE name = $1 AND member = $2`, [name, member]);
  }

  async appendSend(log: string, record: SendRecord, keepMs: number): Promise<void> {
    const json = JSON.stringify({ to_line: record.toLine, recipients: record.recipients, subject: record.subject, body: record.body, at: record.at });
    await this.#query(`INSERT INTO ${this.#t}_sends (log, at, record) VALUES ($1, $2, $3::jsonb)`, [log, record.at, json]);
    await this.#query(
      `DELETE FROM ${this.#t}_sends WHERE log = $1 AND (at < $2::bigint OR id IN (
         SELECT id FROM ${this.#t}_sends WHERE log = $1 ORDER BY at DESC, id DESC OFFSET $3))`,
      [log, record.at - keepMs, SEND_LOG_CAP],
    );
  }

  async recentSends(log: string, since: number): Promise<SendRecord[]> {
    const rows = await this.#query(`SELECT record FROM ${this.#t}_sends WHERE log = $1 AND at >= $2::bigint ORDER BY at, id`, [log, since]);
    return rows.map((r) => {
      const o = (typeof r.record === 'string' ? JSON.parse(r.record) : r.record) as {
        to_line: string;
        recipients: string[];
        subject: string;
        body: string;
        at: number;
      };
      return { toLine: o.to_line, recipients: o.recipients, subject: o.subject, body: o.body, at: Number(o.at) };
    });
  }

  async getState(name: string): Promise<string | null> {
    const rows = await this.#query(`SELECT value FROM ${this.#t}_state WHERE name = $1`, [name]);
    return rows.length > 0 ? String(rows[0]?.value) : null;
  }

  async setState(name: string, value: string | null): Promise<void> {
    if (value === null) await this.#query(`DELETE FROM ${this.#t}_state WHERE name = $1`, [name]);
    else
      await this.#query(
        `INSERT INTO ${this.#t}_state (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
        [name, value],
      );
  }
}

export function postgresStore(db: PgQueryable | PgPoolLike, options?: PostgresStoreOptions): PostgresStore {
  return new PostgresStore(db, options);
}
