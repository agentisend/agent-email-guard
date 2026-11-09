#!/usr/bin/env node
/**
 * agent-email-guard CLI.
 *
 *   agent-email-guard validate [policy.json]          check a policy file
 *   agent-email-guard check [--policy file] [send.json] decide one send (stdin when no file)
 *   agent-email-guard mcp  …   → agent-email-guard-mcp …
 *   agent-email-guard hook …   → agent-email-guard-mcp hook …
 *   agent-email-guard test …   → agent-email-guard-test …
 *
 * `check` exits 0 on allow, 2 on hold_for_approval, 3 on refuse, 1 on error.
 * It uses a fresh in-memory store, so it answers the policy rules (suppression,
 * approval, a budget of 0); budgets and loops need state across sends, which
 * lives in your process or in a shared store.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGuard, type GuardSend } from './guard.js';
import { POLICY_FILE, loadPolicy, validatePolicy } from './policy-file.js';

const FORWARD: Record<string, [string, string[]]> = {
  mcp: ['agent-email-guard-mcp', []],
  hook: ['agent-email-guard-mcp', ['hook']],
  test: ['agent-email-guard-test', []],
};

const USAGE = `agent-email-guard: blast-radius control for agents that send email

  agent-email-guard validate [${POLICY_FILE}]
  agent-email-guard check [--policy ${POLICY_FILE}] [send.json]   (reads stdin without a file)
  agent-email-guard mcp | hook | test [args]
`;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const err = (s: string) => process.stderr.write(`${s}\n`);

  if (command && FORWARD[command]) {
    const [bin, prefix] = FORWARD[command] as [string, string[]];
    return new Promise((resolve) => {
      const child = spawn('npx', ['--yes', bin, ...prefix, ...rest], { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', (e) => {
        err(`Could not start ${bin}: ${e.message}`);
        resolve(1);
      });
    });
  }

  if (command === 'validate') {
    const path = rest[0] ?? POLICY_FILE;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      err(`Cannot read ${path}: ${(e as Error).message}`);
      return 1;
    }
    const problems = validatePolicy(json);
    if (problems.length === 0) {
      out(`${path} is a valid policy.`);
      return 0;
    }
    for (const p of problems) err(p);
    return 1;
  }

  if (command === 'check') {
    let policyPath: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--policy') policyPath = rest[++i];
      else files.push(rest[i] as string);
    }
    try {
      const config = policyPath !== undefined || existsQuiet(POLICY_FILE) ? loadPolicy(policyPath) : {};
      const raw = files[0] ? readFileSync(files[0], 'utf8') : await readStdin();
      const send = JSON.parse(raw) as GuardSend;
      const decision = await createGuard(config).check(send);
      const { reservation: _r, ...shown } = decision;
      out(JSON.stringify(shown, null, 2));
      return decision.outcome === 'allow' ? 0 : decision.outcome === 'hold_for_approval' ? 2 : 3;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }

  out(USAGE);
  return command === undefined || command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
}

function existsQuiet(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

const invokedDirectly = typeof process !== 'undefined' && process.argv[1] !== undefined && /agent-email-guard|cli\.(c?js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
