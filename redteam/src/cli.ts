import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadGuard } from './guard-adapter.js';
import { formatReport, isSkipNoModel, runHarness } from './harness.js';
import { readPolicyFile } from './policy.js';
import { loadScenarios, packageRoot } from './scenarios.js';
import type { RunAgent, SuiteReport } from './types.js';

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(argv: readonly string[], io: CliIO = defaultIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n${usage()}`);
    return 2;
  }
  const root = packageRoot();
  const { benchmark, scenarios } = loadScenarios(root);
  const policyPath = resolvePolicy(parsed.policy, parsed.agentPath, root);
  const policy = readPolicyFile(policyPath);
  const loaded = await loadGuard(policy);
  const agent = await loadAgent(parsed.agentPath);
  let report: SuiteReport;
  try {
    report = await runHarness({
      runAgent: agent,
      scenarios,
      createGuard: loaded.create,
      guardSource: loaded.source,
      policyPath,
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
    });
  } catch (error) {
    if (isSkipNoModel(error)) {
      io.stdout(`${error instanceof Error ? error.message : 'Skipped.'}\n`);
      return 0;
    }
    throw error;
  }
  if (parsed.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout(`${formatReport(report)}\n`);
  return report.pass ? 0 : 1;
}

function usage(): string {
  return [
    'Usage: agent-email-guard-test [--json] [--policy <file>] <agent.ts>',
    '       npx agent-email-guard test [--json] [--policy <file>] <agent.ts>',
    '',
    'The agent file exports runAgent(input, tools). The send tool records attempts and does not deliver mail.',
  ].join('\n');
}

interface Parsed {
  readonly ok: true;
  readonly json: boolean;
  readonly policy: string | null;
  readonly agentPath: string;
}

function parseArgs(argv: readonly string[]): Parsed | { ok: false; error: string } {
  const args = [...argv];
  if (args[0] === 'test') args.shift();
  let json = false;
  let policy: string | null = null;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--policy') {
      const next = args[index + 1];
      if (next === undefined) return { ok: false, error: '--policy needs a file.' };
      policy = next;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { ok: false, error: '' };
    if (arg?.startsWith('-')) return { ok: false, error: `Unknown flag ${arg}.` };
    if (arg !== undefined) positionals.push(arg);
  }
  const agentPath = positionals[0];
  if (agentPath === undefined) return { ok: false, error: 'Name the agent file.' };
  if (positionals.length > 1) return { ok: false, error: 'Pass one agent file.' };
  return { ok: true, json, policy, agentPath };
}

function resolvePolicy(flag: string | null, agentPath: string, root: string): string {
  if (flag !== null) return resolve(flag);
  const cwd = resolve('agent-email-guard.json');
  if (existsSync(cwd)) return cwd;
  const beside = join(dirname(resolve(agentPath)), 'agent-email-guard.json');
  if (existsSync(beside)) return beside;
  return join(root, 'defaults', 'agent-email-guard.json');
}

async function loadAgent(agentPath: string): Promise<RunAgent> {
  const absolute = isAbsolute(agentPath) ? agentPath : resolve(agentPath);
  if (!existsSync(absolute)) throw new Error(`Agent file not found: ${absolute}`);
  const loaded: unknown = await import(pathToFileURL(absolute).href);
  if (typeof loaded !== 'object' || loaded === null || !('runAgent' in loaded) || typeof loaded.runAgent !== 'function') {
    throw new Error(`${absolute} must export runAgent(input, tools).`);
  }
  return loaded.runAgent as RunAgent;
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
