/**
 * Runs one conformance case (spec/SPEC.md §9) against this package. The
 * generator uses it to fill in `expect`; the tests use it to compare.
 */

import { createGuard, MemoryStore, type Decision, type GuardConfig, type GuardSend } from '../src/index.js';

export interface VectorSend {
  key?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
}

export interface VectorConfig {
  key?: string;
  namespace?: string;
  budgets?: { per_hour?: number; per_day?: number; per_month?: number };
  rate?: { per_minute?: number };
  loop?: {
    mode?: 'off' | 'repetition_only' | 'full';
    window_ms?: number;
    similarity_threshold?: number;
    max_identical_sends?: number;
    min_window_for_entropy?: number;
    recipient_perplexity_floor?: number;
  };
  approval?: {
    new_recipients?: boolean;
    recipients?: string[];
    require_for?: { subject_contains: string; detail?: string | null };
  };
  suppress?: string[];
}

export type ExpectedDecision = Omit<Decision, 'reservation'>;

export type VectorStep =
  | { op: 'check' | 'send'; at: number; send: VectorSend; approved?: boolean; expect?: ExpectedDecision; note?: string }
  | { op: 'record'; at: number; send: VectorSend; repeat?: number; every_ms?: number; note?: string }
  | { op: 'release'; at: number; step: number; note?: string }
  | { op: 'pause'; at: number; reason: string; by?: string; note?: string }
  | { op: 'read_state'; at: number; name: string; expect?: { state: unknown }; note?: string }
  | { op: 'resume'; at: number; by: string; expect?: { resumed: boolean }; note?: string };

export interface VectorCase {
  name: string;
  description?: string;
  config: VectorConfig;
  steps: VectorStep[];
}

export interface VectorFile {
  $schema?: string;
  name: string;
  description: string;
  source?: string;
  cases: VectorCase[];
}

export function toGuardConfig(v: VectorConfig, clock: () => number): GuardConfig {
  const rf = v.approval?.require_for;
  return {
    clock,
    ...(v.key !== undefined ? { key: v.key } : {}),
    ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
    ...(v.budgets
      ? { budgets: { perHour: v.budgets.per_hour, perDay: v.budgets.per_day, perMonth: v.budgets.per_month } }
      : {}),
    ...(v.rate ? { rate: { perMinute: v.rate.per_minute } } : {}),
    ...(v.loop
      ? {
          loop: {
            mode: v.loop.mode,
            windowMs: v.loop.window_ms,
            similarityThreshold: v.loop.similarity_threshold,
            maxIdenticalSends: v.loop.max_identical_sends,
            minWindowForEntropy: v.loop.min_window_for_entropy,
            recipientPerplexityFloor: v.loop.recipient_perplexity_floor,
          },
        }
      : {}),
    ...(v.approval
      ? {
          approval: {
            newRecipients: v.approval.new_recipients,
            recipients: v.approval.recipients,
            ...(rf
              ? {
                  requireFor: (s: GuardSend) =>
                    (s.subject ?? '').includes(rf.subject_contains) ? (rf.detail ?? true) : false,
                }
              : {}),
          },
        }
      : {}),
    ...(v.suppress ? { suppress: v.suppress } : {}),
  };
}

export interface StepResult {
  index: number;
  actual: ExpectedDecision | { resumed: boolean } | { state: unknown } | null;
}

function strip(d: Decision): ExpectedDecision {
  return { outcome: d.outcome, reason: d.reason, message: d.message, evidence: d.evidence };
}

/** Run every step; returns the observed result per step (null for steps with no result). */
export async function runCase(c: VectorCase): Promise<StepResult[]> {
  let now = 0;
  const store = new MemoryStore();
  const guard = createGuard({ ...toGuardConfig(c.config, () => now), store });
  const decisions = new Map<number, Decision>();
  const out: StepResult[] = [];
  for (const [index, step] of c.steps.entries()) {
    now = step.at;
    switch (step.op) {
      case 'check':
      case 'send': {
        const d = await guard.check(step.send as GuardSend, { approved: step.approved === true });
        decisions.set(index, d);
        if (step.op === 'send' && d.outcome === 'allow') await guard.record(step.send as GuardSend);
        out.push({ index, actual: strip(d) });
        break;
      }
      case 'record': {
        const n = step.repeat ?? 1;
        for (let k = 0; k < n; k++) {
          now = step.at + k * (step.every_ms ?? 0);
          await guard.record(step.send as GuardSend);
        }
        out.push({ index, actual: null });
        break;
      }
      case 'release': {
        const d = decisions.get(step.step);
        if (!d) throw new Error(`release names step ${step.step}, which has no decision`);
        await guard.release(d);
        out.push({ index, actual: null });
        break;
      }
      case 'pause':
        if (step.by === undefined) await guard.killSwitch.pause(step.reason);
        else await guard.killSwitch.pause(step.reason, step.by);
        out.push({ index, actual: null });
        break;
      case 'read_state': {
        const raw = await store.getState(step.name);
        out.push({ index, actual: { state: raw === null ? null : (JSON.parse(raw) as unknown) } });
        break;
      }
      case 'resume':
        out.push({ index, actual: { resumed: await guard.killSwitch.resume(step.by) } });
        break;
    }
  }
  return out;
}
