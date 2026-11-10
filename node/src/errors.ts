import type { Decision } from './decisions.js';

// Brands, so `instanceof` holds across the ESM and CommonJS builds and across
// subpath entries that each carry their own copy of these classes.
const REFUSED = Symbol.for('agent-email-guard/GuardRefused');
const APPROVAL = Symbol.for('agent-email-guard/ApprovalRequired');

function branded(value: unknown, brand: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;
}

/** Thrown by a wrapped send when the guard refused it. Nothing was sent. */
export class GuardRefused extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return branded(value, REFUSED);
  }
  readonly [REFUSED] = true;
  readonly decision: Decision;
  readonly reason: Decision['reason'];
  override name: string;
  constructor(decision: Decision) {
    super(decision.message);
    this.name = 'GuardRefused';
    this.decision = decision;
    this.reason = decision.reason;
  }
}

/**
 * Thrown by a wrapped send when a person has to approve it first. Nothing was
 * sent. Store it in your own queue; when a person approves, call approve() to
 * run every other check again and send.
 */
export class ApprovalRequired<R = unknown> extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return branded(value, APPROVAL);
  }
  override name: string;
  readonly [APPROVAL] = true;
  readonly decision: Decision;
  readonly reason: Decision['reason'];
  readonly #approve: () => Promise<R>;
  constructor(decision: Decision, approve: () => Promise<R>) {
    super(decision.message);
    this.name = 'ApprovalRequired';
    this.decision = decision;
    this.reason = decision.reason;
    this.#approve = approve;
  }
  /** A person approved: re-check without the approval rules, then send. */
  approve(): Promise<R> {
    return this.#approve();
  }
}
