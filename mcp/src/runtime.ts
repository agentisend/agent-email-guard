import { createGuard, MemoryStore, type Decision, type Guard, type GuardSend } from 'agent-email-guard';
import { createApprovalBook, recipientHashes, type ApprovalBook } from './approvals.js';
import type { ResolvedConfig } from './config.js';
import { FileStore, withKillFile } from './file-store.js';

export interface CheckedSend {
  readonly outcome: Decision['outcome'];
  readonly reason: Decision['reason'];
  readonly message: string;
  readonly approvalId?: string;
  readonly recipientHashes: readonly string[];
  readonly decision: Decision;
  readonly send: GuardSend;
}

export interface OpenedGuard {
  check(send: GuardSend): Promise<CheckedSend>;
  record(row: CheckedSend): Promise<void>;
  release(row: CheckedSend): Promise<void>;
  readonly guard: Guard;
  readonly approvals: ApprovalBook;
}

export function openGuard(config: ResolvedConfig): OpenedGuard {
  const inner = config.store === 'file' ? new FileStore(config.storePath) : new MemoryStore();
  const namespace = config.guard.namespace ?? 'agent-email-guard';
  const guard = createGuard({
    ...config.guard,
    store: withKillFile(inner, config.controlFile, namespace),
  });
  const approvals = createApprovalBook(config.approvalsFile);
  return {
    guard,
    approvals,
    async check(send) {
      const approved = await approvals.isApproved(send);
      const decision = await guard.check(send, { approved });
      if (approved && decision.outcome === 'allow') await approvals.consume(send);
      const approvalId = decision.outcome === 'hold_for_approval' ? await approvals.hold(send) : undefined;
      return {
        outcome: decision.outcome,
        reason: decision.reason,
        message: decision.message,
        ...(approvalId !== undefined ? { approvalId } : {}),
        recipientHashes: recipientHashes(send),
        decision,
        send,
      };
    },
    record(row) {
      return guard.record(row.send);
    },
    release(row) {
      return guard.release(row.decision);
    },
  };
}

export function sendToolSet(config: ResolvedConfig): ReadonlySet<string> | null {
  if (config.sendTools === null) return null;
  return new Set(config.sendTools);
}
