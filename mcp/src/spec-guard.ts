/**
 * The only file that speaks the SPEC §2 surface.
 *
 * On 2026-11-09 `origin/main` (`b1a5213a`) did not yet contain
 * `oss/agent-guard/spec/SPEC.md` or `oss/agent-guard/node`. This file
 * implements the §2.2 operations the MCP brief names — a Send, then
 * `check` / `record` / `release` — so the rest of the package never
 * imports a guard implementation. When `../node` lands, replace
 * `createSpecGuard` with a wrapper around `@agentisend/agent-guard`
 * (`"@agentisend/agent-guard": "file:../node"`) and keep these types.
 *
 * Outcomes are `allow`, `refuse`, and `hold_for_approval`. `check`
 * reserves a budget slot only on `allow`. `record` keeps that slot
 * after the upstream call succeeds. `release` gives it back after an
 * upstream error, so a failed call does not spend the day.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SpecSend {
  readonly key: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface SpecDecision {
  readonly outcome: 'allow' | 'refuse' | 'hold_for_approval';
  readonly reason: string;
  readonly message: string;
  readonly reservationId?: string;
  readonly approvalId?: string;
  /** sha256 of each recipient. Logs use this and never the address. */
  readonly recipientHashes: readonly string[];
}

export interface SpecGuard {
  check(send: SpecSend): Promise<SpecDecision>;
  record(reservationId: string): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface GuardLimits {
  /** Sends (one MCP message, not one recipient) kept for the UTC day. */
  readonly perDay: number;
  readonly perHour?: number;
  /** Sliding 60-second ceiling. Omitted means no per-minute ceiling. */
  readonly perMinute?: number;
  /** `full` refuses the 3rd identical body to the same recipients in the window. `off` does not. */
  readonly loopMode: 'off' | 'full';
  readonly loopWindowMs: number;
  /** Exact addresses, or `@domain` for a whole domain. */
  readonly approvalRecipients: readonly string[];
}

interface LedgerEntry {
  id: string;
  key: string;
  at: number;
  fingerprint: string;
  status: 'reserved' | 'committed';
}

export interface Ledger {
  reserve(
    entry: Omit<LedgerEntry, 'status'>,
    limits: GuardLimits,
    now: number,
  ): Promise<{ ok: true } | ReserveNo>;
  commit(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

interface ReserveNo {
  ok: false;
  reason: 'agent_budget_exceeded' | 'rate_ceiling_exceeded' | 'loop_repetition_detected';
  scope: 'day' | 'hour' | 'minute' | 'loop';
  used: number;
  ceiling: number;
}

interface ApprovalRecord {
  id: string;
  key: string;
  fingerprint: string;
  recipientHashes: string[];
  createdAt: string;
  status: 'pending' | 'approved';
}

export interface ApprovalBook {
  findApproved(key: string, fingerprint: string): Promise<{ id: string } | null>;
  consume(id: string): Promise<void>;
  hold(input: { key: string; fingerprint: string; recipientHashes: string[] }): Promise<string>;
  list(): Promise<ApprovalRecord[]>;
  approve(id: string): Promise<boolean>;
}

const MINUTE_MS = 60 * 1000;

export function hashRecipient(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

export function recipientHashes(send: SpecSend): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of [...send.to, ...send.cc, ...send.bcc]) {
    const hash = hashRecipient(address);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(hash);
  }
  return out;
}

/** Same body and the same recipient set. The address is hashed before it is stored. */
export function sendFingerprint(send: SpecSend): string {
  const body = `${send.text}\n${send.html}`.replace(/\s+/g, ' ').trim().toLowerCase();
  const who = [...send.to, ...send.cc, ...send.bcc].map((address) => address.trim().toLowerCase()).sort().join(',');
  return createHash('sha256').update(`${who}\n${body}`).digest('hex');
}

function matchesRule(address: string, rule: string): boolean {
  const left = address.trim().toLowerCase();
  const right = rule.trim().toLowerCase();
  if (right.startsWith('@')) return left.endsWith(right);
  return left === right;
}

function matchedRule(send: SpecSend, rules: readonly string[]): string | null {
  for (const address of [...send.to, ...send.cc, ...send.bcc]) {
    for (const rule of rules) {
      if (matchesRule(address, rule)) return rule;
    }
  }
  return null;
}

function inWindow(entry: LedgerEntry, now: number, windowMs: number): boolean {
  return now - entry.at < windowMs && now - entry.at >= 0;
}

export function createMemoryLedger(): Ledger {
  const entries: LedgerEntry[] = [];

  return {
    async reserve(entry, limits, now) {
      return decideAndPush(entries, entry, limits, now);
    },
    async commit(id) {
      const found = entries.find((entry) => entry.id === id);
      if (found) found.status = 'committed';
    },
    async release(id) {
      const index = entries.findIndex((entry) => entry.id === id && entry.status === 'reserved');
      if (index >= 0) entries.splice(index, 1);
    },
  };
}

function decideAndPush(
  entries: LedgerEntry[],
  entry: Omit<LedgerEntry, 'status'>,
  limits: GuardLimits,
  now: number,
): { ok: true } | ReserveNo {
  const mine = entries.filter((row) => row.key === entry.key);
  if (limits.loopMode !== 'off') {
    const identical = mine.filter(
      (row) => row.status === 'committed' && row.fingerprint === entry.fingerprint && inWindow(row, now, limits.loopWindowMs),
    ).length;
    // Two committed copies means this call would be the third.
    if (identical >= 2) {
      return { ok: false, reason: 'loop_repetition_detected', scope: 'loop', used: identical, ceiling: 2 };
    }
  }
  const dayCount = mine.filter((row) => sameUtcDay(row.at, now)).length;
  if (dayCount >= limits.perDay) {
    return { ok: false, reason: 'agent_budget_exceeded', scope: 'day', used: dayCount, ceiling: limits.perDay };
  }
  if (limits.perHour !== undefined) {
    const hourCount = mine.filter((row) => sameUtcHour(row.at, now)).length;
    if (hourCount >= limits.perHour) {
      return { ok: false, reason: 'agent_budget_exceeded', scope: 'hour', used: hourCount, ceiling: limits.perHour };
    }
  }
  if (limits.perMinute !== undefined) {
    const minuteCount = mine.filter((row) => inWindow(row, now, MINUTE_MS)).length;
    if (minuteCount >= limits.perMinute) {
      return { ok: false, reason: 'rate_ceiling_exceeded', scope: 'minute', used: minuteCount, ceiling: limits.perMinute };
    }
  }
  entries.push({ ...entry, status: 'reserved' });
  return { ok: true };
}

function sameUtcDay(at: number, now: number): boolean {
  return new Date(at).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
}

function sameUtcHour(at: number, now: number): boolean {
  return new Date(at).toISOString().slice(0, 13) === new Date(now).toISOString().slice(0, 13);
}

interface StoreFile {
  entries: LedgerEntry[];
}

const fileChains = new Map<string, Promise<unknown>>();

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileChains.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, path);
}

export function createFileLedger(path: string): Ledger {
  return {
    reserve(entry, limits, now) {
      return withFileLock(path, async () => {
        const data = await readJson<StoreFile>(path, { entries: [] });
        const result = decideAndPush(data.entries, entry, limits, now);
        await writeJson(path, data);
        return result;
      });
    },
    commit(id) {
      return withFileLock(path, async () => {
        const data = await readJson<StoreFile>(path, { entries: [] });
        const found = data.entries.find((entry) => entry.id === id);
        if (found) found.status = 'committed';
        await writeJson(path, data);
      });
    },
    release(id) {
      return withFileLock(path, async () => {
        const data = await readJson<StoreFile>(path, { entries: [] });
        data.entries = data.entries.filter((entry) => !(entry.id === id && entry.status === 'reserved'));
        await writeJson(path, data);
      });
    },
  };
}

interface ApprovalFile {
  records: ApprovalRecord[];
}

export function createFileApprovals(path: string): ApprovalBook {
  return {
    findApproved(key, fingerprint) {
      return withFileLock(path, async () => {
        const data = await readJson<ApprovalFile>(path, { records: [] });
        const found = data.records.find(
          (row) => row.status === 'approved' && row.key === key && row.fingerprint === fingerprint,
        );
        return found ? { id: found.id } : null;
      });
    },
    consume(id) {
      return withFileLock(path, async () => {
        const data = await readJson<ApprovalFile>(path, { records: [] });
        data.records = data.records.filter((row) => row.id !== id);
        await writeJson(path, data);
      });
    },
    hold(input) {
      return withFileLock(path, async () => {
        const data = await readJson<ApprovalFile>(path, { records: [] });
        const id = `ap_${randomBytes(8).toString('hex')}`;
        data.records.push({
          id,
          key: input.key,
          fingerprint: input.fingerprint,
          recipientHashes: input.recipientHashes,
          createdAt: new Date().toISOString(),
          status: 'pending',
        });
        await writeJson(path, data);
        return id;
      });
    },
    list() {
      return withFileLock(path, async () => {
        const data = await readJson<ApprovalFile>(path, { records: [] });
        return data.records.filter((row) => row.status === 'pending');
      });
    },
    approve(id) {
      return withFileLock(path, async () => {
        const data = await readJson<ApprovalFile>(path, { records: [] });
        const found = data.records.find((row) => row.id === id && row.status === 'pending');
        if (!found) return false;
        found.status = 'approved';
        await writeJson(path, data);
        return true;
      });
    },
  };
}

export interface CreateSpecGuardOptions {
  readonly limits: GuardLimits;
  readonly ledger: Ledger;
  readonly approvals: ApprovalBook;
  readonly isPaused: () => boolean;
  readonly now?: () => number;
}

export function createSpecGuard(options: CreateSpecGuardOptions): SpecGuard {
  const now = options.now ?? (() => Date.now());
  const limits = options.limits;

  return {
    async check(send) {
      const hashes = recipientHashes(send);
      const at = now();
      if (options.isPaused()) {
        return {
          outcome: 'refuse',
          reason: 'kill_switch_active',
          message: 'Sending is paused by the local kill switch. Run agent-email-guard resume to allow sends again.',
          recipientHashes: hashes,
        };
      }
      if (send.to.length === 0) {
        return {
          outcome: 'refuse',
          reason: 'missing_recipient',
          message: 'This call was treated as a send and it names no recipient, so it was not forwarded.',
          recipientHashes: hashes,
        };
      }
      const fingerprint = sendFingerprint(send);
      const approved = await options.approvals.findApproved(send.key, fingerprint);
      if (!approved) {
        const rule = matchedRule(send, limits.approvalRecipients);
        if (rule !== null) {
          const approvalId = await options.approvals.hold({
            key: send.key,
            fingerprint,
            recipientHashes: [...hashes],
          });
          return {
            outcome: 'hold_for_approval',
            reason: 'recipient_requires_approval',
            message: `${rule} matches an approval rule, so this send waits until you approve ${approvalId}.`,
            approvalId,
            recipientHashes: hashes,
          };
        }
      }

      const id = `rsv_${randomBytes(8).toString('hex')}`;
      const reserved = await options.ledger.reserve(
        { id, key: send.key, at, fingerprint },
        limits,
        at,
      );
      if (!reserved.ok) {
        const message =
          reserved.scope === 'loop'
            ? `The same body was already sent to these recipients ${reserved.used} times in the last ${Math.round(limits.loopWindowMs / 60000)} minutes, so this send was refused.`
            : reserved.scope === 'minute'
              ? `The per-minute ceiling is ${reserved.ceiling} and this key already has ${reserved.used} in the last 60 seconds, so this send was refused.`
              : reserved.scope === 'hour'
                ? `The hourly ceiling is ${reserved.ceiling} sends and this key already has ${reserved.used} this hour, so this send was refused.`
                : `The daily ceiling is ${reserved.ceiling} sends and this key already has ${reserved.used} today, so this send was refused.`;
        return { outcome: 'refuse', reason: reserved.reason, message, recipientHashes: hashes };
      }
      if (approved) await options.approvals.consume(approved.id);
      return {
        outcome: 'allow',
        reason: 'ok',
        message: 'Send reserved.',
        reservationId: id,
        recipientHashes: hashes,
      };
    },
    record(reservationId) {
      return options.ledger.commit(reservationId);
    },
    release(reservationId) {
      return options.ledger.release(reservationId);
    },
  };
}
