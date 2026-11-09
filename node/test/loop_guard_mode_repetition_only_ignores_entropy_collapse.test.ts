import { describe, expect, it } from 'vitest';
import { createGuard, type LoopMode } from '../src/index.js';
import { NOW } from './helpers.js';

async function collapsed(mode: LoopMode, count: number, same = false) {
  let now = 0;
  const guard = createGuard({ clock: () => now, loop: { mode } });
  for (let i = 0; i < count; i++) {
    now = NOW - (count - i) * 60_000;
    await guard.record({ to: 'owner@example.com', subject: same ? 'same' : `Alert ${i} ${'abc'.repeat(i % 5)}`, text: same ? 'same body' : `Reading ${i * 17} in region ${i}.` });
  }
  now = NOW;
  return guard;
}

describe('loop_guard_mode_repetition_only_ignores_entropy_collapse', () => {
  it('repetition_only does not hold a dominant recipient', async () => {
    const d = await (await collapsed('repetition_only', 30)).check({ to: 'owner@example.com', subject: 'A new sentence', text: 'Nothing like the alerts.' });
    expect(d.outcome).toBe('allow');
  });
  it('off holds nothing, including a repeated body', async () => {
    const d = await (await collapsed('off', 4, true)).check({ to: 'owner@example.com', subject: 'same', text: 'same body' });
    expect(d.outcome).toBe('allow');
    expect(d.evidence.window_size).toBeUndefined();
  });
  it('repetition_only still refuses repetition', async () => {
    const d = await (await collapsed('repetition_only', 4, true)).check({ to: 'owner@example.com', subject: 'same', text: 'same body' });
    expect(d.reason).toBe('loop_repetition_detected');
  });
  it('full holds the dominant recipient', async () => {
    const d = await (await collapsed('full', 30)).check({ to: 'owner@example.com', subject: 'A new sentence', text: 'Nothing like the alerts.' });
    expect(d.reason).toBe('recipient_entropy_collapse');
  });
});
