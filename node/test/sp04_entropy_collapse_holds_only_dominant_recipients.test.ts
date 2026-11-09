import { describe, expect, it } from 'vitest';
import { createGuard, type GuardSend } from '../src/index.js';
import { NOW } from './helpers.js';

async function alerts(make: (i: number) => Pick<GuardSend, 'to' | 'cc'>) {
  let now = 0;
  const guard = createGuard({ clock: () => now });
  for (let i = 0; i < 30; i++) {
    now = NOW - (30 - i) * 60_000;
    await guard.record({ ...make(i), subject: `Alert ${i}: host ${i * 13}`, text: `Check ${i} crossed step ${i * 7919}.` });
  }
  now = NOW;
  return guard;
}

describe('sp04: entropy collapse holds only candidates addressed to a dominant recipient', () => {
  it('lets a send to a new recipient through', async () => {
    const d = await (await alerts(() => ({ to: 'owner@example.test' }))).check({ to: 'new-user@example.com', subject: 'Your sign-in code', text: 'Your code is 481 902.' });
    expect(d.outcome).toBe('allow');
  });
  it('holds the next send to the collapsed inbox', async () => {
    const d = await (await alerts(() => ({ to: 'owner@example.test' }))).check({ to: 'owner@example.test', subject: 'new wording', text: 'A different sentence.' });
    expect(d.reason).toBe('recipient_entropy_collapse');
    expect(d.evidence.candidate_recipient_share).toBe(1);
  });
  it('counts each address on a send', async () => {
    const d = await (await alerts(() => ({ to: ['owner@example.test', 'cfo@example.test'] }))).check({ to: 'owner@example.test', subject: 'x', text: 'y' });
    expect(d.reason).toBe('recipient_entropy_collapse');
  });
  it('holds a dominant inbox reached through cc', async () => {
    const d = await (await alerts(() => ({ to: 'owner@example.test' }))).check({ to: 'new-user@example.com', cc: 'owner@example.test', subject: 'Welcome', text: 'Welcome aboard.' });
    expect(d.reason).toBe('recipient_entropy_collapse');
  });
  it('reads cc recipients in the window', async () => {
    const d = await (await alerts((i) => ({ to: `rotating-${i % 2}@example.test`, cc: 'owner@example.test' }))).check({ to: 'owner@example.test', subject: 's', text: 'b' });
    expect(d.evidence.distinct_recipients).toBe(3);
    expect(d.reason).toBe('recipient_entropy_collapse');
  });
});
