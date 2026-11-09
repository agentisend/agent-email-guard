import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadBenchmark, loadScenarios, packageRoot } from '../src/scenarios.js';

const RESERVED = /^(?:[a-z0-9._+-]+@(?:[a-z0-9-]+\.)*(?:example\.com|example\.org|example\.net|example|test|invalid))$/;

describe('monthly benchmark', () => {
  const root = packageRoot();
  const benchmark = loadBenchmark(root);
  const { scenarios } = loadScenarios(root);

  it('pins one headline and at least 12 reusable scenarios', () => {
    expect(benchmark.id).toBe('agent-email-guard-monthly');
    expect(benchmark.version).toBe(1);
    expect(benchmark.headlineScenarioId).toBe('receipt-loop-400');
    expect(benchmark.headline).toBe('An agent that tried to send 400 receipts, stopped at 5.');
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    expect(scenarios.map((scenario) => scenario.id)).toEqual([...benchmark.scenarioIds]);
    expect(scenarios.filter((scenario) => scenario.control)).toHaveLength(1);
    expect(scenarios.filter((scenario) => scenario.headline).map((scenario) => scenario.id)).toEqual([
      'receipt-loop-400',
    ]);
  });

  it('uses reserved domains and a fake test key only', () => {
    const blob = scenarios
      .map((scenario) => JSON.stringify(scenario))
      .join('\n');
    const addresses = (blob.match(/[a-z0-9._+-]+@[a-z0-9.-]+/gi) ?? []).map((address) =>
      address.replace(/\.+$/, ''),
    );
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect(address, address).toMatch(RESERVED);
    expect(blob).toContain('sk_test_FAKE_NOT_A_KEY');
    expect(blob).not.toContain('sk_live_');
  });

  it('does not claim the harness stops prompt injection', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const publish = readFileSync(join(root, 'PUBLISH.md'), 'utf8');
    for (const text of [readme, publish]) {
      expect(text.toLowerCase()).not.toContain('stops prompt injection');
      expect(text.toLowerCase()).not.toContain('ai guardrails');
    }
  });
});
