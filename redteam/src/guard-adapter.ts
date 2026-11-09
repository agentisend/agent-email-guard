/**
 * Swap point for `@agentisend/agent-guard`.
 *
 * `oss/agent-guard/node/` was not on origin/main when this package was written
 * (main was b1a5213a, and `oss/agent-guard/spec/SPEC.md` was absent). The
 * reference below implements the decisions this harness needs. When the Node
 * package lands, change `loadGuard` so it constructs that package's §2 guard
 * and delete `createReferenceGuard`. Callers of `Guard` stay as they are.
 */

import type { EmailMessage, Guard, GuardDecision, LimitChange, Policy } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECRET = /sk_test_[A-Za-z0-9_]+/;

interface RecordedSend {
  readonly at: number;
  readonly key: string;
  readonly recipients: readonly string[];
}

export interface LoadedGuard {
  readonly create: () => Guard;
  readonly source: 'reference' | 'node';
}

class ReferenceGuard implements Guard {
  #policy: Policy;
  #now: number;
  readonly #sends: RecordedSend[] = [];
  readonly #newRecipients = new Set<string>();

  constructor(policy: Policy, now: number) {
    this.#policy = policy;
    this.#now = now;
  }

  inspectSend(message: EmailMessage): GuardDecision {
    const recipients = addressesOf(message);
    if (recipients.length === 0) {
      return hold('recipient_requires_approval', 'malformed', 'Held for a person. The message has no recipient.');
    }
    const body = `${message.text ?? ''}\n${message.html ?? ''}`;
    const outside = recipients.filter((address) => !domainKnown(address, this.#policy));
    if (this.#policy.refuseSecretsToNewDomains && SECRET.test(body) && outside.length > 0) {
      return refuse(
        'secret_in_body',
        'secret_pattern',
        'Refused. The body matches a test secret pattern and a recipient domain is outside the known list.',
      );
    }
    if (recipients.length > this.#policy.maxRecipientsPerMessage) {
      return hold(
        'recipient_requires_approval',
        'recipients_per_message',
        `Held for a person. The message names ${recipients.length} recipients, and the policy allows ${this.#policy.maxRecipientsPerMessage} per message.`,
      );
    }
    if (this.#policy.approvalForNewDomains && outside.length > 0) {
      return hold(
        'recipient_requires_approval',
        'new_domain',
        `Held for a person. ${outside[0]} is outside the domains this policy allows without a person.`,
      );
    }
    const fresh = recipients.filter(
      (address) => !this.#policy.knownRecipients.includes(address) && !this.#newRecipients.has(address),
    );
    if (this.#newRecipients.size + fresh.length > this.#policy.maxNewRecipientsPerHour) {
      return hold(
        'recipient_requires_approval',
        'new_recipient_cap',
        `Held for a person. This would be new recipient ${this.#newRecipients.size + fresh.length} in the current hour, and the policy allows ${this.#policy.maxNewRecipientsPerHour}.`,
      );
    }
    const key = fingerprint(message, recipients);
    const identical = this.#sends.filter((send) => send.key === key).length;
    if (identical >= this.#policy.maxIdentical) {
      return refuse(
        'loop_repetition_detected',
        'identical',
        `Refused. This is identical copy ${identical + 1} of this message, and the policy allows ${this.#policy.maxIdentical}.`,
      );
    }
    const inMinute = this.#sends.filter((send) => this.#now - send.at < MINUTE_MS).length;
    if (inMinute >= this.#policy.perMinute) {
      return refuse(
        'rate_ceiling_exceeded',
        'per_minute',
        `Refused. This send would be number ${inMinute + 1} in the current minute, and the policy allows ${this.#policy.perMinute}.`,
      );
    }
    const inHour = this.#sends.filter((send) => this.#now - send.at < HOUR_MS).length;
    if (inHour >= this.#policy.perHour) {
      return refuse(
        'agent_budget_exceeded',
        'per_hour',
        `Refused. This send would be number ${inHour + 1} in the current hour, and the policy allows ${this.#policy.perHour}.`,
      );
    }
    return {
      outcome: 'allow',
      reason: 'ok',
      detail: null,
      message: 'Allowed. The send is inside the policy.',
    };
  }

  inspectLimitChange(change: LimitChange): GuardDecision {
    if (!this.#policy.allowSelfLimitRaise) {
      return refuse(
        'limit_change_refused',
        'self_limit',
        'Refused. This agent cannot raise its own send limits.',
      );
    }
    if (change.perHour === undefined && change.perMinute === undefined && change.maxIdentical === undefined) {
      return refuse('limit_change_refused', 'self_limit', 'Refused. The limit change named no field.');
    }
    return {
      outcome: 'allow',
      reason: 'ok',
      detail: null,
      message: 'Allowed. The policy permits this agent to change its own limits.',
    };
  }

  recordSend(message: EmailMessage): void {
    const recipients = addressesOf(message);
    this.#sends.push({ at: this.#now, key: fingerprint(message, recipients), recipients });
    for (const address of recipients) {
      if (!this.#policy.knownRecipients.includes(address)) this.#newRecipients.add(address);
    }
    this.#now += 1;
  }

  recordLimitChange(change: LimitChange): void {
    this.#policy = {
      ...this.#policy,
      perHour: change.perHour ?? this.#policy.perHour,
      perMinute: change.perMinute ?? this.#policy.perMinute,
      maxIdentical: change.maxIdentical ?? this.#policy.maxIdentical,
    };
  }
}

function allowPass(): Guard {
  return {
    inspectSend: () => ({
      outcome: 'allow',
      reason: 'ok',
      detail: null,
      message: 'Allowed. The guard is off for this run.',
    }),
    inspectLimitChange: () => ({
      outcome: 'allow',
      reason: 'ok',
      detail: null,
      message: 'Allowed. The guard is off for this run.',
    }),
    recordSend: () => undefined,
    recordLimitChange: () => undefined,
  };
}

export function createReferenceGuard(policy: Policy): Guard {
  return new ReferenceGuard(policy, 1_700_000_000_000);
}

export function createOpenGuard(): Guard {
  return allowPass();
}

/**
 * Prefer the Node package when it exports `createEmailGuard(policy)`.
 * Any other shape, or a missing package, keeps the reference guard.
 */
export async function loadGuard(policy: Policy): Promise<LoadedGuard> {
  const specifier: string = '@agentisend/agent-guard';
  try {
    const loaded: unknown = await import(specifier);
    if (isRecord(loaded) && typeof loaded.createEmailGuard === 'function') {
      const factory = loaded.createEmailGuard;
      return {
        source: 'node',
        create: () => {
          const created: unknown = factory(policy);
          if (!isGuard(created)) throw new Error('createEmailGuard did not return a guard.');
          return created;
        },
      };
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'createEmailGuard did not return a guard.') throw error;
    // The package is optional until oss/agent-guard/node is published in-repo.
  }
  return { source: 'reference', create: () => createReferenceGuard(policy) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGuard(value: unknown): value is Guard {
  if (!isRecord(value)) return false;
  return (
    typeof value.inspectSend === 'function' &&
    typeof value.inspectLimitChange === 'function' &&
    typeof value.recordSend === 'function' &&
    typeof value.recordLimitChange === 'function'
  );
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

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1);
}

function domainKnown(address: string, policy: Policy): boolean {
  const domain = domainOf(address);
  return domain !== null && policy.knownDomains.includes(domain);
}

function fingerprint(message: EmailMessage, recipients: readonly string[]): string {
  return JSON.stringify({
    to: [...recipients].sort(),
    subject: message.subject.trim().toLowerCase(),
    text: (message.text ?? '').trim().toLowerCase(),
    html: (message.html ?? '').trim().toLowerCase(),
  });
}

function refuse(reason: string, detail: string, message: string): GuardDecision {
  return { outcome: 'refuse', reason, detail, message };
}

function hold(reason: string, detail: string, message: string): GuardDecision {
  return { outcome: 'hold_for_approval', reason, detail, message };
}
