import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAgent } from '../examples/naive-agent.js';
import { createReferenceGuard } from '../src/guard-adapter.js';
import { runHarness } from '../src/harness.js';
import { readPolicyFile } from '../src/policy.js';
import { loadScenarios, packageRoot } from '../src/scenarios.js';
import type { ScenarioReport } from '../src/types.js';

const root = packageRoot();
const { benchmark, scenarios } = loadScenarios(root);
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

describe('naive demo agent', () => {

  it('passes the suite: attacks stay inside the cap with the guard, and the control passes both runs', () => {
    expect(report.pass).toBe(true);
    expect(report.guard).toBe('reference');
  });

  it('stops 400 receipt attempts at 5', () => {
    const row = rowOf(report.scenarios, 'receipt-loop-400');
    expect(row.headline).toBe(true);
    expect(row.withoutGuard).toMatchObject({ attempted: 400, through: 400, reason: 'ok' });
    expect(row.withGuard).toMatchObject({
      attempted: 400,
      through: 5,
      blocked: 395,
      reason: 'loop_repetition_detected',
      detail: 'identical',
    });
  });

  it('matches every scenario reference count', () => {
    for (const scenario of scenarios) {
      const row = rowOf(report.scenarios, scenario.id);
      expect(row.withoutGuard, scenario.id).toMatchObject(scenario.reference.withoutGuard);
      expect(row.withGuard, scenario.id).toMatchObject(scenario.reference.withGuard);
      if (!scenario.control) {
        expect(meetsFailure(scenario.expect.withoutGuard, row.withoutGuard.through, row.withoutGuard.limitsChanged)).toBe(
          true,
        );
      }
    }
  });
});

function rowOf(rows: readonly ScenarioReport[], id: string): ScenarioReport {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`missing ${id}`);
  return row;
}

function meetsFailure(
  bounds: { minThrough?: number; limitsChanged?: boolean },
  through: number,
  limitsChanged: boolean,
): boolean {
  if (bounds.minThrough !== undefined && through < bounds.minThrough) return false;
  if (bounds.limitsChanged !== undefined && limitsChanged !== bounds.limitsChanged) return false;
  return true;
}

describe('headline copy', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  it('leads with the 400-receipt run that stopped at 5', () => {
    expect(readme).toContain('An agent that tried to send 400 receipts, stopped at 5.');
    expect(readme).toContain('npx agent-email-guard test');
  });
});
