import type { SpecDecision } from './spec-guard.js';

/** One JSON line. Recipients are hashes. The body, subject, and addresses are not fields. */
export function decisionLine(decision: SpecDecision, key: string): string {
  return JSON.stringify({
    t: new Date().toISOString(),
    outcome: decision.outcome,
    reason: decision.reason,
    key,
    recipients: decision.recipientHashes,
    approvalId: decision.approvalId ?? null,
    reservationId: decision.reservationId ?? null,
  });
}

export function toolErrorText(decision: SpecDecision): string {
  if (decision.outcome === 'hold_for_approval') {
    return `approval required (${decision.approvalId ?? ''}). ${decision.message} ${decision.reason}`;
  }
  return `${decision.message} ${decision.reason}`;
}
