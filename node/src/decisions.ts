/**
 * The decision shape and every sentence the guard can say.
 *
 * Reason tokens and message templates are part of the cross-language
 * contract (spec/SPEC.md §4): Python, PHP and Go render byte-identical
 * strings, pinned by spec/vectors/*.json. Change a template here and the
 * vectors, the spec and every port change with it.
 */

export type DecisionOutcome = 'allow' | 'hold_for_approval' | 'refuse';

export const REASON_TOKENS = [
  'ok',
  'kill_switch_active',
  'recipient_suppressed',
  'loop_repetition_detected',
  'recipient_entropy_collapse',
  'recipient_requires_approval',
  'rate_ceiling_exceeded',
  'agent_budget_exceeded',
] as const;

export type ReasonToken = (typeof REASON_TOKENS)[number];

export type EvidenceValue = string | number | boolean | null;
export type DecisionEvidence = Record<string, EvidenceValue>;

/** What check() reserved, so release() can give it back. JSON-serializable. */
export interface Reservation {
  readonly key: string;
  readonly counters: ReadonlyArray<{ readonly name: string; readonly amount: number }>;
  readonly window: { readonly name: string; readonly member: string } | null;
}

export interface Decision {
  readonly outcome: DecisionOutcome;
  readonly reason: ReasonToken;
  /** One human sentence ending in a period. */
  readonly message: string;
  readonly evidence: DecisionEvidence;
  /** Present on an `allow` that reserved budget or rate. Not part of the vectors. */
  readonly reservation?: Reservation;
}

export function isValidDecision(d: Decision): boolean {
  if (!(REASON_TOKENS as readonly string[]).includes(d.reason)) return false;
  if (typeof d.message !== 'string' || d.message.trim().length < 8) return false;
  if (!d.message.trim().endsWith('.')) return false;
  if (typeof d.evidence !== 'object' || d.evidence === null) return false;
  if (d.reason === 'ok' && d.outcome !== 'allow') return false;
  if (d.reason !== 'ok' && d.outcome === 'allow') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Number and text formatting (SPEC §4.1). Every port implements these three
// exactly, or the sentences drift.
// ---------------------------------------------------------------------------

/** Round half up to 3 decimals: floor(x * 1000 + 0.5) / 1000. */
export function round3(n: number): number {
  return Math.floor(n * 1000 + 0.5) / 1000;
}

/** Integers print without a decimal point; other numbers print the shortest round-trip decimal. */
export function formatNumber(n: number): string {
  // JavaScript's String() already prints integers bare and other numbers as
  // the shortest round-trip decimal; ports must match it (SPEC §4.1).
  return String(n);
}

/** "1 email", "2 emails". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Epoch ms → `YYYY-MM-DDTHH:MM:SSZ` (UTC, no fraction). */
export function formatInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Message templates (SPEC §4.2) — one function per sentence.
// ---------------------------------------------------------------------------

export const MESSAGES = {
  ok: (): string => 'No limit, loop or approval rule blocks this send.',

  kill_switch_active: (): string =>
    'Sending is paused by the kill switch, so nothing sends until a person resumes it.',

  recipient_suppressed: (recipient: string, rule: string): string =>
    `${recipient} is on the suppression list (rule: ${rule}), so this guard never sends to it.`,

  loop_repetition_detected: (matches: number, toLine: string, minutes: number): string =>
    `Blocked: ${plural(matches, 'near-identical email')} already went to ${toLine} within ${plural(minutes, 'minute')}, which matches a retry or script loop; review the agent before sending more.`,

  loop_both_signals: (matches: number, toLine: string, effective: number): string =>
    `Blocked: this key shows both a repetition loop (${plural(matches, 'near-identical email')} to ${toLine}) and collapsed recipient diversity (about ${plural(effective, 'effective recipient')}); review the agent before sending more.`,

  recipient_entropy_collapse: (windowSize: number, effective: number): string =>
    `Blocked: the last ${plural(windowSize, 'email')} went to about ${plural(effective, 'effective recipient')}, and this one goes to the same inbox again, which looks like a loop; mail to other recipients still sends.`,

  approval_recipient_rule: (recipient: string, rule: string): string =>
    `${recipient} matches the approval rule ${rule}, so this email waits for a person to approve it.`,

  approval_new_recipient: (recipient: string, key: string): string =>
    `${recipient} has not received email from key "${key}" before, so this email waits for a person to approve it.`,

  approval_custom: (): string =>
    'Your approval rule matched this email, so it waits for a person to approve it.',

  rate_ceiling_exceeded: (key: string, ceiling: number, retryAfterSeconds: number): string =>
    `Key "${key}" reached its ceiling of ${plural(ceiling, 'send')} per minute; wait ${plural(retryAfterSeconds, 'second')} and try again.`,

  agent_budget_exceeded: (key: string, period: BudgetPeriod, budget: number, resetsAt: number): string =>
    `Key "${key}" has used its ${PERIOD_ADJECTIVE[period]} budget of ${plural(budget, 'email')}; it resets at ${formatInstant(resetsAt)}.`,
} as const;

export type BudgetPeriod = 'hour' | 'day' | 'month';

export const PERIOD_ADJECTIVE: Record<BudgetPeriod, string> = {
  hour: 'hourly',
  day: 'daily',
  month: 'monthly',
};

export function decision(
  outcome: DecisionOutcome,
  reason: ReasonToken,
  message: string,
  evidence: DecisionEvidence,
  reservation?: Reservation,
): Decision {
  return reservation ? { outcome, reason, message, evidence, reservation } : { outcome, reason, message, evidence };
}
