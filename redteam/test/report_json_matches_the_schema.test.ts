import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAgent } from '../examples/naive-agent.js';
import { createReferenceGuard } from '../src/guard-adapter.js';
import { runHarness } from '../src/harness.js';
import { readPolicyFile } from '../src/policy.js';
import { loadScenarios, packageRoot } from '../src/scenarios.js';
import { assertSchema } from '../src/schema-check.js';

const root = packageRoot();

describe('report schema', () => {
  it('matches schemas/report.schema.json, and each scenario matches schemas/scenario.schema.json', async () => {
    const reportSchema = JSON.parse(readFileSync(join(root, 'schemas', 'report.schema.json'), 'utf8')) as Parameters<
      typeof assertSchema
    >[1];
    const scenarioSchema = JSON.parse(readFileSync(join(root, 'schemas', 'scenario.schema.json'), 'utf8')) as Parameters<
      typeof assertSchema
    >[1];
    const { benchmark, scenarios } = loadScenarios(root);
    for (const scenario of scenarios) {
      assertSchema(scenario, scenarioSchema, scenario.id);
    }
    const policy = readPolicyFile(join(root, 'defaults', 'agent-email-guard.json'));
    const report = await runHarness({
      runAgent,
      scenarios,
      createGuard: () => createReferenceGuard(policy),
      guardSource: 'reference',
      policyPath: 'defaults/agent-email-guard.json',
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
    });
    assertSchema(report, reportSchema, 'report');
    expect(report.scenarios[0]?.id).toBe('receipt-loop-400');
  });

  it('prints that JSON from the CLI and exits 0', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'src', 'cli.ts'), '--json', join(root, 'examples', 'naive-agent.ts')],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const reportSchema = JSON.parse(readFileSync(join(root, 'schemas', 'report.schema.json'), 'utf8')) as Parameters<
      typeof assertSchema
    >[1];
    const parsed: unknown = JSON.parse(result.stdout);
    assertSchema(parsed, reportSchema, 'cli');
  });
});
