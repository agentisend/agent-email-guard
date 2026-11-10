/**
 * The only place this package talks to agent-email-guard.
 * createGuard and loadPolicy are the published 0.1 API. There is no second
 * rule engine: a scenario the library does not implement is labeled, not
 * decided here.
 */

import { createGuard, MemoryStore, type Guard, type GuardConfig, type GuardSend } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';

import type { EmailMessage, GuardDecision, LimitChange } from './types.js';

export const NOT_COVERED = 'not covered by agent-email-guard 0.1';

/** Scenarios whose rule is not in agent-email-guard 0.1. */
export const UNCOVERED_SCENARIOS: ReadonlySet<string> = new Set([
  'secret-exfil-new-domain',
  'inbound-contact-list',
  'raise-own-limits',
]);

export function isUncovered(id: string): boolean {
  return UNCOVERED_SCENARIOS.has(id);
}

export interface Session {
  check(message: EmailMessage): Promise<GuardDecision>;
  /** Call only after check() allowed. Feeds loop memory. Budget was already reserved by check(). */
  record(message: EmailMessage): Promise<void>;
  /**
   * 0.1 has no API that refuses a self-raised limit. This rebuilds the guard
   * with the new numbers so the following sends show what that policy lets through.
   */
  applyLimitChange(change: LimitChange): void;
}

export function readLibraryPolicy(path: string): GuardConfig {
  return loadPolicy(path);
}

export function createLibrarySession(config: GuardConfig): Session {
  return new LibrarySession(config);
}

export function createOpenSession(): Session {
  return {
    check: () =>
      Promise.resolve({
        outcome: 'allow',
        reason: 'ok',
        detail: null,
        message: 'Allowed. The guard is off for this run.',
      }),
    record: () => Promise.resolve(),
    applyLimitChange: () => undefined,
  };
}

class LibrarySession implements Session {
  #config: GuardConfig;
  #guard: Guard;
  #now = 1_700_000_000_000;

  constructor(config: GuardConfig) {
    this.#config = config;
    this.#guard = this.#build();
  }

  async check(message: EmailMessage): Promise<GuardDecision> {
    const decision = await this.#guard.check(toSend(message));
    const rule = decision.evidence.rule;
    const period = decision.evidence.period;
    return {
      outcome: decision.outcome,
      reason: decision.reason,
      message: decision.message,
      detail: typeof rule === 'string' ? rule : typeof period === 'string' ? period : null,
    };
  }

  async record(message: EmailMessage): Promise<void> {
    await this.#guard.record(toSend(message));
  }

  applyLimitChange(change: LimitChange): void {
    const budgets = { ...this.#config.budgets };
    if (change.perHour !== undefined) budgets.perHour = change.perHour;
    this.#config = {
      ...this.#config,
      budgets,
      rate: change.perMinute !== undefined ? { perMinute: change.perMinute } : this.#config.rate,
      loop:
        change.maxIdentical !== undefined
          ? { ...this.#config.loop, maxIdenticalSends: change.maxIdentical }
          : this.#config.loop,
    };
    this.#guard = this.#build();
  }

  #build(): Guard {
    return createGuard({
      ...this.#config,
      store: new MemoryStore(),
      clock: () => {
        const now = this.#now;
        this.#now += 1;
        return now;
      },
    });
  }
}

function toSend(message: EmailMessage): GuardSend {
  return {
    to: [...message.to],
    cc: message.cc === undefined ? undefined : [...message.cc],
    subject: message.subject,
    text: message.text,
    html: message.html,
  };
}

export function addressesOf(message: EmailMessage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...message.to, ...(message.cc ?? [])]) {
    const address = raw.trim().toLowerCase();
    if (address === '' || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}
