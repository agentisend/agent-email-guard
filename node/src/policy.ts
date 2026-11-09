/**
 * The policy file, agent-email-guard.json (SPEC §2.9): the declarative part of
 * a GuardConfig, in the snake_case keys every language reads. Callbacks
 * (requireFor), stores and clocks stay in code.
 */

import type { GuardConfig } from './guard.js';
import type { LoopMode } from './loop.js';

export const POLICY_FILE = 'agent-email-guard.json';

export interface Policy {
  $schema?: string;
  $comment?: unknown;
  namespace?: string;
  version?: 1;
  key?: string;
  budgets?: { per_hour?: number; per_day?: number; per_month?: number };
  rate?: { per_minute?: number };
  loop?: {
    mode?: LoopMode;
    window_ms?: number;
    similarity_threshold?: number;
    max_identical_sends?: number;
    min_window_for_entropy?: number;
    recipient_perplexity_floor?: number;
  };
  approval?: { new_recipients?: boolean; recipients?: string[] };
  suppress?: string[];
}

const SHAPE: Record<string, Record<string, 'int' | 'num' | 'bool' | 'str' | 'strs' | 'mode'> | 'str' | 'strs' | 'one' | 'any'> = {
  $schema: 'any',
  $comment: 'any',
  namespace: 'str',
  version: 'one',
  key: 'str',
  budgets: { per_hour: 'int', per_day: 'int', per_month: 'int' },
  rate: { per_minute: 'int' },
  loop: {
    mode: 'mode',
    window_ms: 'int',
    similarity_threshold: 'num',
    max_identical_sends: 'int',
    min_window_for_entropy: 'int',
    recipient_perplexity_floor: 'num',
  },
  approval: { new_recipients: 'bool', recipients: 'strs' },
  suppress: 'strs',
};

function checkLeaf(kind: string, v: unknown): boolean {
  switch (kind) {
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0;
    case 'num':
      return typeof v === 'number' && Number.isFinite(v) && v > 0;
    case 'bool':
      return typeof v === 'boolean';
    case 'str':
      return typeof v === 'string' && v.length > 0;
    case 'strs':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'mode':
      return v === 'full' || v === 'repetition_only' || v === 'off';
    case 'one':
      return v === 1;
    default:
      return true;
  }
}

/** Every problem with a policy object, as sentences. Empty means valid. */
export function validatePolicy(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['The policy must be a JSON object.'];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const shape = SHAPE[k];
    if (shape === undefined) {
      problems.push(`Unknown key "${k}".`);
    } else if (typeof shape === 'string') {
      if (!checkLeaf(shape, v)) problems.push(`"${k}" has the wrong type.`);
    } else if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      problems.push(`"${k}" must be an object.`);
    } else {
      for (const [k2, v2] of Object.entries(v)) {
        const leaf = shape[k2];
        if (leaf === undefined) problems.push(`Unknown key "${k}.${k2}".`);
        else if (!checkLeaf(leaf, v2)) problems.push(`"${k}.${k2}" has the wrong type.`);
      }
    }
  }
  return problems;
}

/** A validated policy as createGuard config. Throws a TypeError listing every problem. */
export function policyToConfig(input: unknown): GuardConfig {
  const problems = validatePolicy(input);
  if (problems.length > 0) throw new TypeError(`Invalid agent-email-guard policy: ${problems.join(' ')}`);
  const p = input as Policy;
  const config: { -readonly [K in keyof GuardConfig]: GuardConfig[K] } = {};
  if (p.key !== undefined) config.key = p.key;
  if (p.namespace !== undefined) config.namespace = p.namespace;
  if (p.budgets) config.budgets = { perHour: p.budgets.per_hour, perDay: p.budgets.per_day, perMonth: p.budgets.per_month };
  if (p.rate) config.rate = { perMinute: p.rate.per_minute };
  if (p.loop) {
    config.loop = {
      mode: p.loop.mode,
      windowMs: p.loop.window_ms,
      similarityThreshold: p.loop.similarity_threshold,
      maxIdenticalSends: p.loop.max_identical_sends,
      minWindowForEntropy: p.loop.min_window_for_entropy,
      recipientPerplexityFloor: p.loop.recipient_perplexity_floor,
    };
  }
  if (p.approval) config.approval = { newRecipients: p.approval.new_recipients, recipients: p.approval.recipients };
  if (p.suppress) config.suppress = p.suppress;
  return config;
}
