import { createFileApprovals, createFileLedger, createMemoryLedger, createSpecGuard } from './spec-guard.js';
import type { SpecGuard } from './spec-guard.js';
import { readPaused } from './control.js';
import type { ResolvedConfig } from './config.js';

const LOOP_WINDOW_MS = 60 * 60 * 1000;

export function openGuard(config: ResolvedConfig): SpecGuard {
  const ledger = config.store === 'file' ? createFileLedger(config.storePath) : createMemoryLedger();
  return createSpecGuard({
    limits: {
      perDay: config.perDay,
      ...(config.perHour !== undefined ? { perHour: config.perHour } : {}),
      ...(config.perMinute !== undefined ? { perMinute: config.perMinute } : {}),
      loopMode: config.loopMode,
      loopWindowMs: LOOP_WINDOW_MS,
      approvalRecipients: config.approvalRecipients,
    },
    ledger,
    approvals: createFileApprovals(config.approvalsFile),
    isPaused: () => readPaused(config.controlFile),
  });
}

export function sendToolSet(config: ResolvedConfig): ReadonlySet<string> | null {
  if (config.sendTools === null) return null;
  return new Set(config.sendTools);
}
