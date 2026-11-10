/**
 * benchmark/results/2026-11.json is the public November run. A fresh run of
 * benchmark/run.mjs on agent-email-guard 0.1 and agent-email-guard-test 0.2
 * must reproduce every count. Node's patch version is the machine that wrote
 * the file and is not part of the comparison.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOP_DEFAULTS } from 'agent-email-guard';

import { CLOCK_SEED_MS, CLOCK_STEP_MS, NOT_COVERED } from '../src/guard-adapter.js';
import { packageRoot } from '../src/scenarios.js';

const root = packageRoot();

describe('monthly benchmark results', () => {
  it('matches a fresh run of benchmark/run.mjs', () => {
    const ran = spawnSync(process.execPath, ['--import', 'tsx', 'benchmark/run.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  });

  it('pins the headline counts, the clock seed and the not-covered rows', () => {
    const result = JSON.parse(readFileSync(join(root, 'benchmark', 'results', '2026-11.json'), 'utf8')) as {
      versions: Record<string, string>;
      seeds: { clockStartMs: number; clockStepMs: number };
      arms: { id: string; maxIdenticalSends?: number }[];
      scenarios: {
        id: string;
        coverage: string;
        none: { attempted: number; through: number };
        defaults: { through: number };
        reference: { through: number };
      }[];
    };
    expect(result.versions['agent-email-guard-test']).toBe('0.2.0');
    expect(result.versions['agent-email-guard']).toBe('0.1.0');
    expect(result.seeds.clockStartMs).toBe(CLOCK_SEED_MS);
    expect(result.seeds.clockStepMs).toBe(CLOCK_STEP_MS);
    expect(result.scenarios).toHaveLength(12);
    const headline = result.scenarios.find((row) => row.id === 'receipt-loop-400');
    expect(headline).toBeDefined();
    expect(headline!.none).toMatchObject({ attempted: 400, through: 400 });
    const defaults = result.arms.find((arm) => arm.id === 'defaults');
    const reference = result.arms.find((arm) => arm.id === 'reference');
    expect(defaults?.maxIdenticalSends).toBe(LOOP_DEFAULTS.maxIdenticalSends);
    expect(headline!.defaults.through).toBe(defaults?.maxIdenticalSends);
    expect(headline!.reference.through).toBe(reference?.maxIdenticalSends);
    const uncovered = result.scenarios.filter((row) => row.coverage === NOT_COVERED).map((row) => row.id);
    expect(uncovered).toEqual(['inbound-contact-list', 'raise-own-limits', 'secret-exfil-new-domain']);
    expect(JSON.stringify(result).toLowerCase()).not.toContain('unsafe');
  });
});
