/**
 * The store contract (SPEC §6). Five atomic operations and a send log; every
 * backend (memory, Redis, Postgres, your own) implements exactly this.
 *
 * The one rule that matters: incrementWithCeiling and windowAdd are each ONE
 * atomic step. Read-then-write is the bug this package exists to prevent —
 * two racing callers at used = budget - 1 must not both get through.
 */

/** One accepted send, as the loop detector compares it. Text fields are already normalized. */
export interface SendRecord {
  /** Sorted, comma-joined To addresses. Repetition compares this. */
  readonly toLine: string;
  /** Every address the send reached (To, Cc, Bcc). Entropy counts these. */
  readonly recipients: readonly string[];
  /** normalizeText(subject). */
  readonly subject: string;
  /** normalizeText(body), cut to BODY_COMPARE_CHARS. */
  readonly body: string;
  /** Epoch ms. */
  readonly at: number;
}

export interface CounterResult {
  /** True when the increment was applied. */
  readonly ok: boolean;
  /** The counter after the increment when ok, otherwise its unchanged value. */
  readonly value: number;
}

export interface WindowResult {
  readonly ok: boolean;
  /** Members inside the window after the call (including the new one when ok). */
  readonly count: number;
  /** Timestamp of the oldest member still inside the window, or null when empty. */
  readonly oldestAt: number | null;
}

export interface GuardStore {
  /**
   * Atomically: if value + amount <= ceiling (or ceiling is null), add amount
   * and return {ok: true, value: new}; otherwise change nothing and return
   * {ok: false, value: current}. A missing counter is 0. `expiresAt` (epoch
   * ms, or null for never) lets the backend drop the counter afterwards.
   */
  incrementWithCeiling(name: string, amount: number, ceiling: number | null, expiresAt: number | null): Promise<CounterResult>;
  /** Subtract amount, never below 0. */
  decrement(name: string, amount: number): Promise<void>;
  getCounter(name: string): Promise<number>;
  /**
   * Sliding window, atomically: drop members with `at - memberAt >= windowMs`;
   * if the remaining count < ceiling, add (member, at) and return ok.
   */
  windowAdd(name: string, member: string, at: number, windowMs: number, ceiling: number): Promise<WindowResult>;
  windowRemove(name: string, member: string): Promise<void>;
  /** Append to a key's send log. Entries older than `keepMs` before `record.at` may be dropped. */
  appendSend(log: string, record: SendRecord, keepMs: number): Promise<void>;
  /** Every logged send with `at >= since`, oldest first. */
  recentSends(log: string, since: number): Promise<SendRecord[]>;
  getState(name: string): Promise<string | null>;
  setState(name: string, value: string | null): Promise<void>;
}

/** The send log keeps at most this many entries per key. */
export const SEND_LOG_CAP = 10_000;

/**
 * The default store: one process, nothing shared. Two processes with their own
 * memory stores enforce two separate budgets — use Redis or Postgres for that.
 *
 * JavaScript runs each method body to completion between awaits, so every
 * operation below is atomic within the process.
 */
export class MemoryStore implements GuardStore {
  readonly #counters = new Map<string, { value: number; expiresAt: number | null }>();
  readonly #windows = new Map<string, Map<string, number>>();
  readonly #logs = new Map<string, SendRecord[]>();
  readonly #state = new Map<string, string>();

  async incrementWithCeiling(name: string, amount: number, ceiling: number | null, expiresAt: number | null): Promise<CounterResult> {
    const current = this.#counters.get(name)?.value ?? 0;
    if (ceiling !== null && current + amount > ceiling) return { ok: false, value: current };
    this.#counters.set(name, { value: current + amount, expiresAt });
    return { ok: true, value: current + amount };
  }

  async decrement(name: string, amount: number): Promise<void> {
    const entry = this.#counters.get(name);
    if (!entry) return;
    entry.value = Math.max(0, entry.value - amount);
  }

  async getCounter(name: string): Promise<number> {
    return this.#counters.get(name)?.value ?? 0;
  }

  async windowAdd(name: string, member: string, at: number, windowMs: number, ceiling: number): Promise<WindowResult> {
    const win = this.#windows.get(name) ?? new Map<string, number>();
    for (const [m, t] of win) if (at - t >= windowMs) win.delete(m);
    this.#windows.set(name, win);
    let oldest: number | null = null;
    for (const t of win.values()) if (oldest === null || t < oldest) oldest = t;
    if (win.size >= ceiling) return { ok: false, count: win.size, oldestAt: oldest };
    win.set(member, at);
    return { ok: true, count: win.size, oldestAt: oldest ?? at };
  }

  async windowRemove(name: string, member: string): Promise<void> {
    this.#windows.get(name)?.delete(member);
  }

  async appendSend(log: string, record: SendRecord, keepMs: number): Promise<void> {
    const list = this.#logs.get(log) ?? [];
    list.push(record);
    let drop = 0;
    while (drop < list.length && record.at - (list[drop] as SendRecord).at > keepMs) drop++;
    if (list.length - drop > SEND_LOG_CAP) drop = list.length - SEND_LOG_CAP;
    if (drop > 0) list.splice(0, drop);
    this.#logs.set(log, list);
  }

  async recentSends(log: string, since: number): Promise<SendRecord[]> {
    return (this.#logs.get(log) ?? []).filter((r) => r.at >= since);
  }

  async getState(name: string): Promise<string | null> {
    return this.#state.get(name) ?? null;
  }

  async setState(name: string, value: string | null): Promise<void> {
    if (value === null) this.#state.delete(name);
    else this.#state.set(name, value);
  }
}
