import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/index.js';
import { NOW } from './helpers.js';

const ROADMAP = {
  to: 'victim@example.com',
  subject: 'Quick question about your roadmap',
  text: 'Hi, I wanted to follow up on my last note about your Q3 roadmap. Any interest?',
};

async function guardAfter(count: number, at = (i: number) => NOW - (count - i) * 10) {
  let now = 0;
  const guard = createGuard({ clock: () => now });
  for (let i = 0; i < count; i++) {
    now = at(i);
    await guard.record(ROADMAP);
  }
  now = NOW;
  return guard;
}

describe('loop detection: the 4,000-identical-send retry loop', () => {
  it('refuses the 4,001st near-identical send with evidence', async () => {
    const guard = await guardAfter(4000);
    const d = await guard.check({ ...ROADMAP, text: 'Hi, I wanted to follow up on my last note about my Q3 roadmap. Any interest?' });
    expect(d.outcome).toBe('refuse');
    expect(d.reason).toBe('loop_repetition_detected');
    expect(d.evidence.matching_sends_in_window).toBe(4000);
    expect(d.evidence.repetition_threshold).toBe(3);
    expect(d.evidence.window_ms).toBe(3_600_000);
    expect(Number(d.evidence.closest_subject_similarity)).toBeGreaterThan(0.99);
    expect(Number(d.evidence.closest_body_similarity)).toBeGreaterThanOrEqual(0.85);
    expect(d.message).toMatch(/near-identical emails/);
    expect(d.message.endsWith('.')).toBe(true);
  });

  it('flags once the threshold is crossed, not before', async () => {
    expect((await (await guardAfter(2)).check(ROADMAP)).outcome).toBe('allow');
    expect((await (await guardAfter(3)).check(ROADMAP)).reason).toBe('loop_repetition_detected');
  });

  it('does not count sends outside the window', async () => {
    const guard = await guardAfter(50, () => NOW - 2 * 3_600_000);
    expect((await guard.check(ROADMAP)).outcome).toBe('allow');
  });

  it('a wrapped send in a retry loop stops at the fourth', async () => {
    let now = NOW;
    const guard = createGuard({ clock: () => now });
    let delivered = 0;
    const send = guard.wrap(async (_m: typeof ROADMAP) => ({ id: String(++delivered) }));
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      now += 1000;
      outcomes.push(await send(ROADMAP).then(() => 'sent', (e: Error) => e.name));
    }
    expect(delivered).toBe(3);
    expect(outcomes.slice(3).every((o) => o === 'GuardRefused')).toBe(true);
  });
});
