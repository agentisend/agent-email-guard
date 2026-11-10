/**
 * Monthly runaway-agent benchmark.
 *
 * Runs the 12 scenarios in benchmark/monthly.json on agent-email-guard-test
 * 0.2 against the installed agent-email-guard, three ways: no guard, the
 * library defaults (createGuard with no policy file), and the reference
 * policy. Writes benchmark/results/2026-11.json. Nothing is delivered.
 *
 *   node --import tsx benchmark/run.mjs
 *   node --import tsx benchmark/run.mjs --check
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOOP_DEFAULTS } from 'agent-email-guard';
import { runAgent } from '../examples/naive-agent.ts';
import { CLOCK_SEED_MS, CLOCK_STEP_MS, createLibrarySession } from '../src/guard-adapter.ts';
import { runHarness } from '../src/harness.ts';
import { readPolicyFile } from '../src/policy.ts';
import { loadScenarios, packageRoot } from '../src/scenarios.ts';

const require = createRequire(import.meta.url);
const RESULTS_NAME = '2026-11.json';

const METRICS = ['attempted', 'through', 'blocked', 'reason', 'detail', 'limitsChanged'];

export async function measure() {
  const root = packageRoot();
  const { benchmark, scenarios } = loadScenarios(root);
  if (scenarios.length !== 12) {
    throw new Error(`monthly.json lists ${scenarios.length} scenarios; this run is the set of 12.`);
  }
  const testPackage = require('../package.json');
  const guardPackage = require('agent-email-guard/package.json');
  const referencePath = join(root, benchmark.referencePolicy);
  const referencePolicy = readPolicyFile(referencePath);

  const defaultsReport = await runHarness({
    runAgent,
    scenarios,
    createGuard: () => createLibrarySession({}),
    guardSource: 'agent-email-guard',
    policyPath: 'agent-email-guard defaults',
    benchmarkId: benchmark.id,
    benchmarkVersion: benchmark.version,
  });
  const referenceReport = await runHarness({
    runAgent,
    scenarios,
    createGuard: () => createLibrarySession(referencePolicy),
    guardSource: 'agent-email-guard',
    policyPath: benchmark.referencePolicy,
    benchmarkId: benchmark.id,
    benchmarkVersion: benchmark.version,
  });

  const defaultsById = new Map(defaultsReport.scenarios.map((row) => [row.id, row]));
  const referenceById = new Map(referenceReport.scenarios.map((row) => [row.id, row]));
  const rows = [];
  for (const id of benchmark.scenarioIds) {
    const defaults = defaultsById.get(id);
    const reference = referenceById.get(id);
    const scenario = scenarios.find((item) => item.id === id);
    if (!defaults || !reference || !scenario) throw new Error(`Missing scenario ${id}.`);
    if (JSON.stringify(pick(defaults.withoutGuard)) !== JSON.stringify(pick(reference.withoutGuard))) {
      throw new Error(`${id}: the no-guard arm differed between the two runs.`);
    }
    if (defaults.coverage !== reference.coverage) {
      throw new Error(`${id}: coverage differed between the two guarded arms.`);
    }
    rows.push({
      id,
      name: scenario.name,
      task: scenario.task,
      coverage: reference.coverage,
      none: pick(defaults.withoutGuard),
      defaults: pick(defaults.withGuard),
      reference: pick(reference.withGuard),
    });
  }

  const files = ['benchmark/monthly.json', ...benchmark.scenarioIds.map((id) => `scenarios/${id}.json`), 'examples/naive-agent.ts'];
  const inputsSha256 = createHash('sha256');
  const fileHashes = {};
  for (const relative of files) {
    const bytes = readFileSync(join(root, relative));
    fileHashes[relative] = createHash('sha256').update(bytes).digest('hex');
    inputsSha256.update(relative);
    inputsSha256.update('\0');
    inputsSha256.update(bytes);
  }

  return {
    id: benchmark.id,
    version: benchmark.version,
    published: benchmark.published,
    headlineScenarioId: benchmark.headlineScenarioId,
    agent: 'examples/naive-agent.ts',
    versions: {
      'agent-email-guard-test': testPackage.version,
      'agent-email-guard': guardPackage.version,
      node: process.version,
    },
    seeds: {
      clockStartMs: CLOCK_SEED_MS,
      clockStepMs: CLOCK_STEP_MS,
      inputsSha256: inputsSha256.digest('hex'),
      files: fileHashes,
    },
    arms: [
      { id: 'none', label: 'no guard' },
      {
        id: 'defaults',
        label: 'agent-email-guard defaults',
        maxIdenticalSends: LOOP_DEFAULTS.maxIdenticalSends,
        perHour: null,
        perMinute: null,
      },
      {
        id: 'reference',
        label: 'reference policy',
        policy: benchmark.referencePolicy,
        maxIdenticalSends: referencePolicy.loop?.maxIdenticalSends ?? null,
        perHour: referencePolicy.budgets?.perHour ?? null,
        perMinute: referencePolicy.rate?.perMinute ?? null,
      },
    ],
    scenarios: rows,
    repro: [
      'cd oss/agent-guard/redteam',
      'pnpm install',
      'node --import tsx benchmark/run.mjs',
    ],
  };
}

function pick(mode) {
  return {
    attempted: mode.attempted,
    through: mode.through,
    blocked: mode.blocked,
    reason: mode.reason,
    detail: mode.detail,
    limitsChanged: mode.limitsChanged,
  };
}

export function resultsPath(root = packageRoot()) {
  return join(root, 'benchmark', 'results', RESULTS_NAME);
}

/** Counts, coverage, seeds and package versions. Node's own version is the machine that wrote the file. */
export function comparable(result) {
  return {
    id: result.id,
    version: result.version,
    published: result.published,
    headlineScenarioId: result.headlineScenarioId,
    agent: result.agent,
    test: result.versions['agent-email-guard-test'],
    guard: result.versions['agent-email-guard'],
    seeds: { clockStartMs: result.seeds.clockStartMs, clockStepMs: result.seeds.clockStepMs, inputsSha256: result.seeds.inputsSha256 },
    arms: result.arms,
    scenarios: result.scenarios,
    repro: result.repro,
    metrics: METRICS,
  };
}

function readCommitted(root) {
  return JSON.parse(readFileSync(resultsPath(root), 'utf8'));
}

async function main() {
  const check = process.argv.includes('--check');
  const result = await measure();
  const root = packageRoot();
  if (check) {
    const committed = readCommitted(root);
    const same = JSON.stringify(comparable(result)) === JSON.stringify(comparable(committed));
    if (!same) {
      process.stderr.write('benchmark/results/2026-11.json does not match a fresh run. Re-run without --check.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('benchmark/results/2026-11.json matches this run.\n');
    return;
  }
  const path = resultsPath(root);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  const headline = result.scenarios.find((row) => row.id === result.headlineScenarioId);
  process.stdout.write(
    `wrote benchmark/results/${RESULTS_NAME} — ${result.scenarios.length} scenarios, ${headline.id} attempted ${headline.none.attempted}, through ${headline.none.through} / ${headline.defaults.through} / ${headline.reference.through}\n`,
  );
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
