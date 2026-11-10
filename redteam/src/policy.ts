import type { GuardConfig } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';

/** agent-email-guard.json, via the published loadPolicy. Unknown keys throw. */
export function readPolicyFile(path: string): GuardConfig {
  return loadPolicy(path);
}
