import { describe, expect, it } from 'vitest';
import { createGuard, type GuardSend } from '../src/index.js';
import { NOW } from './helpers.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
const FIRST = ['ana', 'belle', 'carlos', 'dee', 'elena', 'farid', 'gita', 'hugo', 'ines', 'jonas'];
const LAST = ['acme', 'bright', 'cedarline', 'deltaworks', 'everly', 'foxglove', 'granitetech'];
const TOPICS = ['invoice', 'receipt', 'welcome', 'password reset', 'weekly digest', 'shipping notice'];

async function replay(sends: Array<{ at: number; send: GuardSend }>) {
  let now = 0;
  const guard = createGuard({ clock: () => now });
  for (const s of sends) {
    now = s.at;
    await guard.record(s.send);
  }
  now = NOW;
  return guard;
}

function legitimate(count: number, seed: number) {
  const r = lcg(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)] as T;
  return Array.from({ length: count }, (_, i) => ({
    at: NOW - (count - i) * 30_000,
    send: {
      to: `${pick(FIRST)}@${pick(LAST)}.com`,
      subject: `Your ${pick(TOPICS)} (#${Math.floor(r() * 100000)})`,
      text: `Hello ${pick(FIRST)}, here are the details you asked for regarding ${pick(TOPICS)}. Reference ${Math.floor(r() * 1e9)}.`,
    },
  }));
}

describe('false-positive guard: diverse legitimate traffic is NOT flagged', () => {
  it('clears 120 varied transactional sends', async () => {
    const guard = await replay(legitimate(120, 42));
    const d = await guard.check({ to: 'newcustomer@brightco.io', subject: 'Your invoice (#88213)', text: 'Hello ana, here are the details you asked for regarding invoice. Reference 554032987.' });
    expect(d.outcome).toBe('allow');
    expect(Number(d.evidence.distinct_recipients)).toBeGreaterThan(40);
    expect(Number(d.evidence.effective_recipients)).toBeGreaterThan(10);
  });

  it('does not trust entropy on a 12-send sample', async () => {
    const guard = await replay(legitimate(12, 7));
    expect((await guard.check({ to: 'one@of-the-three.com', subject: 's', text: 'b' })).outcome).toBe('allow');
  });

  it('does not flag repeat correspondence with individually written content', async () => {
    const sends = Array.from({ length: 150 }, (_, n) => ({
      at: NOW - (150 - n) * 20_000,
      send: {
        to: `customer${n % 25}@theirco.com`,
        subject: `Re: ticket ${n % 25} update ${Math.floor(n / 25)}`,
        text: `Round ${Math.floor(n / 25)} for ticket ${n % 25}: we reproduced the issue on build ${Math.floor(n / 25)}${n % 25} and shipped a fix candidate.`,
      },
    }));
    const guard = await replay(sends);
    expect((await guard.check({ to: 'customer7@theirco.com', subject: 'Re: ticket 7 update 6', text: 'Round 6 for ticket 7: fix verified in staging.' })).outcome).toBe('allow');
  });
});
