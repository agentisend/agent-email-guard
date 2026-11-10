/**
 * Every decision case in spec/vectors, through this package's FileStore
 * and the published agent-email-guard createGuard. Policy-validation
 * cases have no store; they go through the same package's validatePolicy.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGuard, isValidDecision, type Decision, type GuardConfig, type GuardSend } from 'agent-email-guard';
import { validatePolicy } from 'agent-email-guard/policy';
import { FileStore } from '../src/file-store.js';

interface VectorSend {
  key?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
}

interface VectorConfig {
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

type VectorStep =
  | { op: 'check' | 'send'; at: number; send: VectorSend; approved?: boolean; expect?: unknown }
  | { op: 'record'; at: number; send: VectorSend; repeat?: number; every_ms?: number }
  | { op: 'release'; at: number; step: number }
  | { op: 'pause'; at: number; reason: string; by?: string }
  | { op: 'read_state'; at: number; name: string; expect?: { state: unknown } }
  | { op: 'resume'; at: number; by: string; expect?: { resumed: boolean } };

interface VectorCase {
  name: string;
  config?: VectorConfig;
  steps?: VectorStep[];
  policy?: unknown;
  expect?: { problems: string[] };
}

interface VectorFile {
  name: string;
  cases: VectorCase[];
}

const vectorDir = join(import.meta.dirname, '..', '..', 'spec', 'vectors');

function loadVectors(): VectorFile[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.json') && name !== 'vector.schema.json') files.push(path);
      else if (!name.includes('.')) walk(path);
    }
  };
  walk(vectorDir);
  return files.sort().map((path) => JSON.parse(readFileSync(path, 'utf8')) as VectorFile);
}

function toGuardConfig(v: VectorConfig, clock: () => number): GuardConfig {
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
                  requireFor: (send: GuardSend) =>
                    (send.subject ?? '').includes(rf.subject_contains) ? (rf.detail ?? true) : false,
                }
              : {}),
          },
        }
      : {}),
    ...(v.suppress ? { suppress: v.suppress } : {}),
  };
}

function strip(decision: Decision): Omit<Decision, 'reservation'> {
  return { outcome: decision.outcome, reason: decision.reason, message: decision.message, evidence: decision.evidence };
}

async function runCase(c: VectorCase, storePath: string): Promise<Array<{ index: number; actual: unknown }>> {
  let now = 0;
  const store = new FileStore(storePath);
  const guard = createGuard({ ...toGuardConfig(c.config ?? {}, () => now), store });
  const decisions = new Map<number, Decision>();
  const out: Array<{ index: number; actual: unknown }> = [];
  for (const [index, step] of (c.steps ?? []).entries()) {
    now = step.at;
    switch (step.op) {
      case 'check':
      case 'send': {
        const decision = await guard.check(step.send as GuardSend, { approved: step.approved === true });
        decisions.set(index, decision);
        if (step.op === 'send' && decision.outcome === 'allow') await guard.record(step.send as GuardSend);
        out.push({ index, actual: strip(decision) });
        break;
      }
      case 'record': {
        const n = step.repeat ?? 1;
        for (let k = 0; k < n; k += 1) {
          now = step.at + k * (step.every_ms ?? 0);
          await guard.record(step.send as GuardSend);
        }
        out.push({ index, actual: null });
        break;
      }
      case 'release': {
        const decision = decisions.get(step.step);
        if (!decision) throw new Error(`release names step ${step.step}, which has no decision`);
        await guard.release(decision);
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
      default:
        break;
    }
  }
  return out;
}

const files = loadVectors();
const decisionCases = files.flatMap((file) => file.cases.filter((c) => c.steps).map((c) => ({ file: file.name, c })));
const policyCases = files.flatMap((file) => file.cases.filter((c) => c.policy !== undefined).map((c) => ({ file: file.name, c })));

describe('spec vectors through the file store', () => {
  it('loads the 49 decision cases', () => {
    expect(decisionCases).toHaveLength(49);
    expect(policyCases).toHaveLength(10);
  });

  for (const { file, c } of decisionCases) {
    it(`${file} / ${c.name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-vec-'));
      const results = await runCase(c, join(dir, 'store.json'));
      for (const result of results) {
        const step = c.steps?.[result.index] as { expect?: unknown };
        if (step?.expect === undefined) continue;
        expect(result.actual, `${file} / ${c.name} / step ${result.index}`).toEqual(step.expect);
        if (result.actual && typeof result.actual === 'object' && 'outcome' in result.actual) {
          expect(isValidDecision(result.actual as Decision)).toBe(true);
        }
      }
    });
  }

  for (const { file, c } of policyCases) {
    it(`${file} / ${c.name}`, () => {
      expect(validatePolicy(c.policy)).toEqual(c.expect?.problems ?? []);
    });
  }

  it('200 concurrent checks against a file-store budget of 50 allow exactly 50', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-race-'));
    const guard = createGuard({
      budgets: { perDay: 50 },
      store: new FileStore(join(dir, 'store.json')),
      clock: () => 1_800_000_000_000,
    });
    const results = await Promise.all(
      Array.from({ length: 200 }, () => guard.check({ to: 'a@example.com', subject: 'n', text: 'body' })),
    );
    expect(results.filter((decision) => decision.outcome === 'allow')).toHaveLength(50);
  });
});
