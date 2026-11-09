import { describe, expect, it } from 'vitest';
import { createGuard, isValidDecision, REASON_TOKENS, type Decision } from '../src/index.js';
import { runCase } from '../scripts/vector-runner.js';
import { loadVectors } from './helpers.js';

async function everyDecision(): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const file of loadVectors()) for (const c of file.cases) for (const r of await runCase(c)) if (r.actual && 'outcome' in r.actual) out.push(r.actual as Decision);
  return out;
}

describe('every decision carries a machine token and a human sentence', () => {
  it('the vectors produce every token at least once', async () => {
    const reasons = new Set((await everyDecision()).map((d) => d.reason));
    for (const token of REASON_TOKENS) expect(reasons, token).toContain(token);
  });

  it('every decision validates the contract', async () => {
    for (const d of await everyDecision()) {
      expect(isValidDecision(d), JSON.stringify(d)).toBe(true);
      expect(d.message).not.toMatch(/\bundefined\b|\bnull\b|\[object|NaN/);
    }
  });

  it('hosted-only tokens are not in the open-source list', () => {
    expect(REASON_TOKENS as readonly string[]).not.toContain('trust_paused');
    expect(REASON_TOKENS as readonly string[]).not.toContain('brand_impersonation');
  });

  it('a requireFor callback may be async', async () => {
    const guard = createGuard({ approval: { requireFor: async (s) => ((s.subject ?? '').includes('wire') ? 'Wire transfers need a person.' : false) } });
    const d = await guard.check({ to: 'cfo@example.com', subject: 'wire instructions', text: 'x' });
    expect(d.outcome).toBe('hold_for_approval');
    expect(d.evidence.detail).toBe('Wire transfers need a person.');
  });
});
