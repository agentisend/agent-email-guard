import { describe, expect, it } from 'vitest';
import { createGuard, MemoryStore } from '../src/index.js';
import { interleaving, NOW } from './helpers.js';

const send = (i: number) => ({ to: `user${i}@example.com`, subject: `Receipt ${i}`, text: `Order ${i}` });

describe('b08 budget race: concurrent checks never overshoot', () => {
  it('200 concurrent checks against a budget of 50 admit exactly 50', async () => {
    const store = new MemoryStore();
    const guard = createGuard({ store: interleaving(store), clock: () => NOW, budgets: { perDay: 50 }, loop: { mode: 'off' } });
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => guard.check(send(i))));
    const admitted = results.filter((d) => d.outcome === 'allow');
    const refused = results.filter((d) => d.reason === 'agent_budget_exceeded');
    expect(admitted).toHaveLength(50);
    expect(refused).toHaveLength(150);
    expect(Math.max(...admitted.map((d) => Number(d.evidence.day_used)))).toBe(50);
  });

  it('every refusal names agent_budget_exceeded with the reset time', async () => {
    const guard = createGuard({ clock: () => NOW, budgets: { perDay: 1 }, loop: { mode: 'off' } });
    await guard.check(send(1));
    const blocked = await guard.check(send(2));
    expect(blocked.outcome).toBe('refuse');
    expect(blocked.reason).toBe('agent_budget_exceeded');
    expect(blocked.message).toMatch(/resets at 2027-01-16T00:00:00Z\.$/);
    expect(blocked.evidence.budget).toBe(1);
  });

  it('the per-minute ceiling refuses independently of the budget and reserves none of it', async () => {
    const store = new MemoryStore();
    const guard = createGuard({ store, clock: () => NOW, budgets: { perDay: 1000 }, rate: { perMinute: 5 }, loop: { mode: 'off' } });
    for (let i = 0; i < 5; i++) expect((await guard.check(send(i))).outcome).toBe('allow');
    const sixth = await guard.check(send(6));
    expect(sixth.reason).toBe('rate_ceiling_exceeded');
    expect(sixth.evidence.sends_in_window).toBe(5);
    expect(sixth.evidence.ceiling_per_minute).toBe(5);
    expect(Number(sixth.evidence.retry_after_seconds)).toBeGreaterThan(0);
    const dayStart = Math.floor(NOW / 86_400_000) * 86_400_000;
    expect(await store.getCounter(`agent-email-guard:default:budget:day:${dayStart}`)).toBe(5);
  });

  it('a refused send leaves no partial state behind', async () => {
    const store = new MemoryStore();
    const guard = createGuard({ store: interleaving(store), clock: () => NOW, budgets: { perHour: 10, perDay: 12 }, rate: { perMinute: 1000 }, loop: { mode: 'off' } });
    await Promise.all(Array.from({ length: 40 }, (_, i) => guard.check(send(i))));
    const hourStart = Math.floor(NOW / 3_600_000) * 3_600_000;
    const dayStart = Math.floor(NOW / 86_400_000) * 86_400_000;
    expect(await store.getCounter(`agent-email-guard:default:budget:hour:${hourStart}`)).toBe(10);
    // The 30 hourly refusals gave back nothing they had not taken: the daily counter equals admissions.
    expect(await store.getCounter(`agent-email-guard:default:budget:day:${dayStart}`)).toBe(10);
  });

  it('release() gives back budget and rate after a provider failure', async () => {
    const guard = createGuard({ clock: () => NOW, budgets: { perHour: 1 }, rate: { perMinute: 1 }, loop: { mode: 'off' } });
    const first = await guard.check(send(1));
    expect(first.outcome).toBe('allow');
    await guard.release(first);
    await guard.release(first);
    expect((await guard.check(send(2))).outcome).toBe('allow');
    expect((await guard.check(send(3))).outcome).toBe('refuse');
  });
});
