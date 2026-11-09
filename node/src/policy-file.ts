/** Read agent-email-guard.json from disk (Node only; the core never touches the filesystem). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuardConfig } from './guard.js';
import { POLICY_FILE, policyToConfig } from './policy.js';

export { POLICY_FILE, policyToConfig, validatePolicy, type Policy } from './policy.js';

/** Load and validate a policy file. Default: ./agent-email-guard.json. */
export function loadPolicy(path: string = POLICY_FILE): GuardConfig {
  const full = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`No policy file at ${full}. Create ${POLICY_FILE} or pass a path.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${full} is not valid JSON: ${(err as Error).message}`);
  }
  return policyToConfig(json);
}
