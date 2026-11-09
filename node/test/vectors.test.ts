import { describe, expect, it } from 'vitest';
import { isValidDecision, type Decision } from '../src/index.js';
import { runCase, type VectorStep } from '../scripts/vector-runner.js';
import { loadVectors } from './helpers.js';

describe('spec/vectors: every case matches step for step', () => {
  const files = loadVectors();
  it('loads the 11 vector files', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });
  for (const file of files) {
    describe(file.name, () => {
      for (const c of file.cases) {
        it(c.name, async () => {
          const results = await runCase(c);
          for (const r of results) {
            const step = c.steps[r.index] as VectorStep & { expect?: unknown };
            if (!('expect' in step) || step.expect === undefined) continue;
            expect(r.actual, `${file.name} / ${c.name} / step ${r.index}`).toEqual(step.expect);
            if (r.actual && 'outcome' in r.actual) expect(isValidDecision(r.actual as Decision)).toBe(true);
          }
        });
      }
    });
  }
});
