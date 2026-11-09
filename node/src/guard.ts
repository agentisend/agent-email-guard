/**
 * createGuard: the public entry point (SPEC §2, §7).
 *
 * check() runs, in this order, stopping at the first block:
 *   1. kill switch          refuse  kill_switch_active
 *   2. suppression list     refuse  recipient_suppressed
 *   3. loop detection       refuse  loop_repetition_detected | recipient_entropy_collapse
 *   4. approval rules       hold    recipient_requires_approval   (skipped when approved)
 *   5. rate ceiling         refuse  rate_ceiling_exceeded         (reserves)
 *   6. budgets hour→month   refuse  agent_budget_exceeded         (reserves)
 *   7. allow                        ok
 * Nothing before step 5 reserves anything, so a refusal or hold never needs
 * undoing; a budget refusal at step 6 gives back what steps 5–6 reserved.
 */

import {
  MESSAGES,
  decision,
  type BudgetPeriod,
  type Decision,
  type DecisionEvidence,
  type Reservation,
} from './decisions.js';
import { ApprovalRequired, GuardRefused } from './errors.js';
import { detectLoop, resolveLoopConfig, type LoopConfig } from './loop.js';
import { MemoryStore, type GuardStore, type SendRecord } from './store.js';
import { BODY_COMPARE_CHARS, addressList, normalizeAddress, normalizeText, type AddressField } from './text.js';

/** The provider-neutral description of one email. */
export interface GuardSend {
  /** Which agent/key this send counts against. Default: config.key, then "default". */
  readonly key?: string;
  readonly from?: AddressField;
  readonly to: AddressField;
  readonly cc?: AddressField;
  readonly bcc?: AddressField;
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
}

export interface BudgetConfig {
  readonly perHour?: number;
  readonly perDay?: number;
  readonly perMonth?: number;
}

export type RequireFor = (send: GuardSend) => boolean | string | null | undefined | Promise<boolean | string | null | undefined>;

export interface ApprovalConfig {
  /** Hold a send when any recipient has never had a send recorded by this key. */
  readonly newRecipients?: boolean;
  /** Exact addresses or whole domains ("@bigco.com") that always need a person. */
  readonly recipients?: readonly string[];
  /** Your own rule. Truthy holds the send; a string becomes evidence.detail. */
  readonly requireFor?: RequireFor;
}

export interface GuardConfig {
  readonly key?: string;
  readonly budgets?: BudgetConfig;
  readonly rate?: { readonly perMinute?: number };
  readonly loop?: LoopConfig;
  readonly approval?: ApprovalConfig;
  /** Exact addresses or whole domains this guard never sends to. */
  readonly suppress?: readonly string[];
  readonly store?: GuardStore;
  /** Epoch ms. Default Date.now. */
  readonly clock?: () => number;
  /** Prefix for every store name. Default "agent-email-guard". */
  readonly namespace?: string;
}

export interface CheckOptions {
  /** A person approved this send: skip the approval rules, keep every other check. */
  readonly approved?: boolean;
}

export interface KillSwitchState {
  readonly paused: boolean;
  readonly pausedAt: number | null;
  readonly pausedBy: string | null;
  readonly reason: string | null;
}

export interface KillSwitch {
  /** Stop every send through this guard (every key) until resume(). Never resumes on its own. */
  pause(reason: string, by?: string): Promise<KillSwitchState>;
  /** Returns false, and records nothing, when the switch was not paused. */
  resume(by: string): Promise<boolean>;
  state(): Promise<KillSwitchState>;
}

export interface WrapOptions<A extends unknown[]> {
  /** Map the provider call's arguments to a GuardSend. Default: the first argument as-is. */
  readonly toGuardSend?: (...args: A) => GuardSend;
}

export interface Guard {
  check(send: GuardSend, options?: CheckOptions): Promise<Decision>;
  /** Call after the provider accepted the send: feeds loop detection and the new-recipient memory. */
  record(send: GuardSend): Promise<void>;
  /** Call when the provider failed: gives back what check() reserved. Safe to call twice. */
  release(decision: Decision): Promise<void>;
  wrap<A extends unknown[], R>(sendFn: (...args: A) => Promise<R> | R, options?: WrapOptions<A>): (...args: A) => Promise<R>;
  readonly killSwitch: KillSwitch;
}

const DEFAULT_KEY = 'default';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;

/** [start, end) of the UTC calendar period containing `now`. */
export function periodBounds(period: BudgetPeriod, now: number): [number, number] {
  if (period === 'hour') {
    const start = Math.floor(now / HOUR) * HOUR;
    return [start, start + HOUR];
  }
  if (period === 'day') {
    const start = Math.floor(now / DAY) * DAY;
    return [start, start + DAY];
  }
  const d = new Date(now);
  return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
}

function matchesRule(address: string, rule: string): boolean {
  const r = normalizeAddress(rule);
  if (r.startsWith('@')) return address.endsWith(r);
  return address === r;
}

function firstRuleMatch(addresses: readonly string[], rules: readonly string[] | undefined): [string, string] | null {
  if (!rules || rules.length === 0) return null;
  for (const a of addresses) for (const rule of rules) if (matchesRule(a, rule)) return [a, normalizeAddress(rule)];
  return null;
}

/** The parts of a send the guard compares (SPEC §3). */
export function toRecord(send: GuardSend, at: number): SendRecord {
  const to = addressList(send.to);
  const recipients = [...to];
  for (const a of [...addressList(send.cc), ...addressList(send.bcc)]) if (!recipients.includes(a)) recipients.push(a);
  return {
    toLine: [...to].sort().join(','),
    recipients,
    subject: normalizeText(send.subject ?? ''),
    body: normalizeText(send.text ? send.text : (send.html ?? '')).slice(0, BODY_COMPARE_CHARS),
    at,
  };
}

let memberCounter = 0;
function newMember(now: number): string {
  memberCounter = (memberCounter + 1) % 1_000_000_000;
  return `${now}-${memberCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createGuard(config: GuardConfig = {}): Guard {
  const store = config.store ?? new MemoryStore();
  const clock = config.clock ?? Date.now;
  const ns = config.namespace ?? 'agent-email-guard';
  const loopCfg = resolveLoopConfig(config.loop);
  const budgets: Array<[BudgetPeriod, number]> = [];
  if (config.budgets?.perHour !== undefined) budgets.push(['hour', config.budgets.perHour]);
  if (config.budgets?.perDay !== undefined) budgets.push(['day', config.budgets.perDay]);
  if (config.budgets?.perMonth !== undefined) budgets.push(['month', config.budgets.perMonth]);
  const perMinute = config.rate?.perMinute;
  const released = new WeakSet<Reservation>();

  const keyOf = (send: GuardSend): string => send.key ?? config.key ?? DEFAULT_KEY;
  const killName = `${ns}:kill`;
  const logName = (key: string): string => `${ns}:${key}:log`;
  const seenName = (key: string, address: string): string => `${ns}:${key}:seen:${address}`;

  async function readKill(): Promise<KillSwitchState> {
    const raw = await store.getState(killName);
    if (raw === null) return { paused: false, pausedAt: null, pausedBy: null, reason: null };
    const parsed = JSON.parse(raw) as { paused_at: number; paused_by: string; reason: string };
    return { paused: true, pausedAt: parsed.paused_at, pausedBy: parsed.paused_by, reason: parsed.reason };
  }

  async function check(send: GuardSend, options: CheckOptions = {}): Promise<Decision> {
    const now = clock();
    const key = keyOf(send);

    // 1. Kill switch.
    const kill = await readKill();
    if (kill.paused) {
      return decision('refuse', 'kill_switch_active', MESSAGES.kill_switch_active(), {
        paused_at: kill.pausedAt,
        paused_by: kill.pausedBy,
        pause_reason: kill.reason,
      });
    }

    const candidate = toRecord(send, now);

    // 2. Suppression.
    const suppressed = firstRuleMatch(candidate.recipients, config.suppress);
    if (suppressed) {
      return decision('refuse', 'recipient_suppressed', MESSAGES.recipient_suppressed(suppressed[0], suppressed[1]), {
        recipient: suppressed[0],
        matched_rule: suppressed[1],
      });
    }

    // 3. Loop detection.
    const evidence: DecisionEvidence = { key };
    if (loopCfg.mode !== 'off') {
      const recent = await store.recentSends(logName(key), now - loopCfg.windowMs);
      const loop = detectLoop(recent, candidate, now, loopCfg);
      if (loop.decision) return loop.decision;
      Object.assign(evidence, loop.stats);
    }

    // 4. Approval.
    if (options.approved === true) {
      evidence.approved = true;
    } else {
      const ruled = firstRuleMatch(candidate.recipients, config.approval?.recipients);
      if (ruled) {
        return decision('hold_for_approval', 'recipient_requires_approval', MESSAGES.approval_recipient_rule(ruled[0], ruled[1]), {
          rule: 'recipient_list',
          recipient: ruled[0],
          matched_rule: ruled[1],
        });
      }
      if (config.approval?.requireFor) {
        const verdict = await config.approval.requireFor(send);
        if (verdict) {
          return decision('hold_for_approval', 'recipient_requires_approval', MESSAGES.approval_custom(), {
            rule: 'custom',
            detail: typeof verdict === 'string' ? verdict : null,
          });
        }
      }
      if (config.approval?.newRecipients === true) {
        const unseen: string[] = [];
        for (const a of candidate.recipients) if ((await store.getCounter(seenName(key, a))) === 0) unseen.push(a);
        if (unseen.length > 0) {
          return decision('hold_for_approval', 'recipient_requires_approval', MESSAGES.approval_new_recipient(unseen[0] as string, key), {
            rule: 'new_recipient',
            recipient: unseen[0] as string,
            new_recipients: unseen.join(','),
          });
        }
      }
    }

    // 5. Rate ceiling (reserves a window slot).
    const counters: Array<{ name: string; amount: number }> = [];
    let windowSlot: { name: string; member: string } | null = null;
    if (perMinute !== undefined) {
      const name = `${ns}:${key}:rate`;
      const member = newMember(now);
      const res = await store.windowAdd(name, member, now, MINUTE, perMinute);
      if (!res.ok) {
        const retry = res.oldestAt === null ? 60 : Math.max(1, Math.ceil((res.oldestAt + MINUTE - now) / 1000));
        return decision('refuse', 'rate_ceiling_exceeded', MESSAGES.rate_ceiling_exceeded(key, perMinute, retry), {
          key,
          sends_in_window: res.count,
          ceiling_per_minute: perMinute,
          retry_after_seconds: retry,
        });
      }
      windowSlot = { name, member };
      evidence.rate_used = res.count;
      evidence.rate_ceiling = perMinute;
    }

    // 6. Budgets, hour → day → month (each reserves one).
    for (const [period, budget] of budgets) {
      const [start, end] = periodBounds(period, now);
      const name = `${ns}:${key}:budget:${period}:${start}`;
      const res = await store.incrementWithCeiling(name, 1, budget, end);
      if (!res.ok) {
        await giveBack({ key, counters, window: windowSlot });
        return decision('refuse', 'agent_budget_exceeded', MESSAGES.agent_budget_exceeded(key, period, budget, end), {
          key,
          period,
          budget,
          used: res.value,
          resets_at: end,
        });
      }
      counters.push({ name, amount: 1 });
      evidence[`${period}_used`] = res.value;
      evidence[`${period}_budget`] = budget;
    }

    const reservation: Reservation | undefined =
      counters.length > 0 || windowSlot !== null ? { key, counters, window: windowSlot } : undefined;
    return decision('allow', 'ok', MESSAGES.ok(), evidence, reservation);
  }

  async function giveBack(r: Reservation): Promise<void> {
    for (const c of r.counters) await store.decrement(c.name, c.amount);
    if (r.window) await store.windowRemove(r.window.name, r.window.member);
  }

  async function release(d: Decision): Promise<void> {
    const r = d.reservation;
    if (!r || released.has(r)) return;
    released.add(r);
    await giveBack(r);
  }

  async function record(send: GuardSend): Promise<void> {
    const now = clock();
    const key = keyOf(send);
    const rec = toRecord(send, now);
    await store.appendSend(logName(key), rec, loopCfg.windowMs);
    for (const a of rec.recipients) await store.incrementWithCeiling(seenName(key, a), 1, null, null);
  }

  function wrap<A extends unknown[], R>(sendFn: (...args: A) => Promise<R> | R, options: WrapOptions<A> = {}) {
    const map = options.toGuardSend ?? ((...args: A) => args[0] as GuardSend);
    const run = async (approved: boolean, args: A): Promise<R> => {
      const send = map(...args);
      const d = await check(send, { approved });
      if (d.outcome === 'refuse') throw new GuardRefused(d);
      if (d.outcome === 'hold_for_approval') throw new ApprovalRequired(d, () => run(true, args));
      let result: R;
      try {
        result = await sendFn(...args);
      } catch (err) {
        await release(d);
        throw err;
      }
      await record(send);
      return result;
    };
    return (...args: A): Promise<R> => run(false, args);
  }

  const killSwitch: KillSwitch = {
    async pause(reason: string, by = 'agent-email-guard'): Promise<KillSwitchState> {
      const at = clock();
      await store.setState(killName, JSON.stringify({ paused_at: at, paused_by: by, reason }));
      return { paused: true, pausedAt: at, pausedBy: by, reason };
    },
    async resume(by: string): Promise<boolean> {
      const current = await readKill();
      if (!current.paused) return false;
      await store.setState(
        `${killName}:last_resume`,
        JSON.stringify({ paused_at: current.pausedAt, paused_by: current.pausedBy, reason: current.reason, resumed_at: clock(), resumed_by: by }),
      );
      await store.setState(killName, null);
      return true;
    },
    state: readKill,
  };

  return { check, record, release, wrap, killSwitch };
}
