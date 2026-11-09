import { describe, expect, it } from 'vitest';
import { createGuard } from '../src/index.js';
import { NOW } from './helpers.js';

async function mutatedLoop(count: number) {
  let now = 0;
  const guard = createGuard({ clock: () => now });
  for (let i = 0; i < count; i++) {
    now = NOW - (count - i) * 5_000;
    await guard.record({
      to: i % 2 === 0 ? 'target@example.com' : 'target2@example.com',
      subject: `Following up, note ${i} of my sequence`,
      text: `Message ${i}: ${'x'.repeat(3 + (i % 7))} quick thought on your ${['pricing', 'roadmap', 'team', 'growth'][i % 4]} plans. Ref ${i * 7919}.`,
    });
  }
  now = NOW;
  return guard;
}

describe('entropy collapse is detected independently of exact repetition', () => {
  it('flags a two-recipient content-mutating loop that repetition cannot see', async () => {
    const d = await (await mutatedLoop(60)).check({ to: 'target@example.com', subject: 'Following up, note 60', text: 'Totally new wording entirely unrelated to prior sends.' });
    expect(d.reason).toBe('recipient_entropy_collapse');
    expect(d.evidence.signal_repetition).toBe(false);
    expect(d.evidence.matching_sends_in_window).toBe(0);
    expect(d.evidence.distinct_recipients).toBe(2);
    expect(d.evidence.entropy_bits).toBe(1);
    expect(d.evidence.effective_recipients).toBe(2);
    expect(d.message).toMatch(/2 effective recipients/);
  });

  it('keeps a diverse window of the same size clean', async () => {
    let now = 0;
    const guard = createGuard({ clock: () => now });
    for (let i = 0; i < 60; i++) {
      now = NOW - (60 - i) * 5_000;
      await guard.record({ to: `lead${i}@company${i % 30}.com`, subject: `Update ${i}`, text: `Unique message ${i} with distinct trigrams.` });
    }
    now = NOW;
    expect((await guard.check({ to: 'lead60@company30.com', subject: 'Update 60', text: 'A fresh unique message.' })).outcome).toBe('allow');
  });
});
