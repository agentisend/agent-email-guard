import { PGlite } from '@electric-sql/pglite';
import RedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { createGuard, type Decision, type GuardStore } from '../src/index.js';
import { PostgresStore } from '../src/stores/postgres.js';
import { RedisStore, type RedisLike } from '../src/stores/redis.js';
import { toGuardConfig, type VectorStep } from '../scripts/vector-runner.js';
import { loadVectors, NOW } from './helpers.js';

type Factory = () => Promise<GuardStore>;

const backends: Array<[string, Factory]> = [
  [
    'postgres (PGlite)',
    async () => {
      const store = new PostgresStore(new PGlite() as unknown as ConstructorParameters<typeof PostgresStore>[0]);
      await store.migrate();
      return store;
    },
  ],
  ['redis (ioredis-mock)', async () => new RedisStore(new RedisMock() as unknown as RedisLike)],
];

/** Same runner as vector-runner.ts, with an injected store. */
async function runWithStore(steps: VectorStep[], config: Parameters<typeof toGuardConfig>[0], store: GuardStore) {
  let now = 0;
  const guard = createGuard({ ...toGuardConfig(config, () => now), store, namespace: `t${Math.random().toString(36).slice(2, 8)}` });
  const decisions = new Map<number, Decision>();
  for (const [i, step] of steps.entries()) {
    now = step.at;
    if (step.op === 'check' || step.op === 'send') {
      const d = await guard.check(step.send, { approved: step.approved === true });
      decisions.set(i, d);
      if (step.op === 'send' && d.outcome === 'allow') await guard.record(step.send);
      const { reservation: _r, ...plain } = d;
      expect(plain, `step ${i}`).toEqual(step.expect);
    } else if (step.op === 'record') {
      for (let k = 0; k < (step.repeat ?? 1); k++) {
        now = step.at + k * (step.every_ms ?? 0);
        await guard.record(step.send);
      }
    } else if (step.op === 'release') {
      await guard.release(decisions.get(step.step) as Decision);
    } else if (step.op === 'pause') {
      await guard.killSwitch.pause(step.reason, step.by);
    } else if (step.op === 'read_state') {
      // Store names carry this run's random namespace; vectors.test.ts pins them on the memory store.
    } else if (step.op === 'resume') {
      expect({ resumed: await guard.killSwitch.resume(step.by) }).toEqual(step.expect);
    }
  }
}

for (const [label, make] of backends) {
  describe(`${label}: the store contract`, () => {
    it('incrementWithCeiling never passes the ceiling and reports the current value', async () => {
      const s = await make();
      expect(await s.incrementWithCeiling('c', 1, 2, null)).toEqual({ ok: true, value: 1 });
      expect(await s.incrementWithCeiling('c', 1, 2, null)).toEqual({ ok: true, value: 2 });
      expect(await s.incrementWithCeiling('c', 1, 2, null)).toEqual({ ok: false, value: 2 });
      expect(await s.incrementWithCeiling('z', 1, 0, null)).toEqual({ ok: false, value: 0 });
      await s.decrement('c', 5);
      expect(await s.getCounter('c')).toBe(0);
      expect(await s.incrementWithCeiling('u', 7, null, NOW + 1000)).toEqual({ ok: true, value: 7 });
    });

    it('windowAdd slides and windowRemove frees a slot', async () => {
      const s = await make();
      expect(await s.windowAdd('w', 'a', 1000, 60_000, 2)).toEqual({ ok: true, count: 1, oldestAt: 1000 });
      expect(await s.windowAdd('w', 'b', 2000, 60_000, 2)).toEqual({ ok: true, count: 2, oldestAt: 1000 });
      expect(await s.windowAdd('w', 'c', 3000, 60_000, 2)).toEqual({ ok: false, count: 2, oldestAt: 1000 });
      expect(await s.windowAdd('w', 'c', 61_000, 60_000, 2)).toEqual({ ok: true, count: 2, oldestAt: 2000 });
      await s.windowRemove('w', 'c');
      expect((await s.windowAdd('w', 'd', 61_001, 60_000, 2)).ok).toBe(true);
    });

    it('the send log returns records since a time, oldest first', async () => {
      const s = await make();
      const rec = (at: number) => ({ toLine: 'a@x.io', recipients: ['a@x.io'], subject: 'hi', body: 'b', at });
      await s.appendSend('l', rec(1000), 60_000);
      await s.appendSend('l', rec(2000), 60_000);
      await s.appendSend('l', rec(100_000), 60_000);
      expect((await s.recentSends('l', 0)).map((r) => r.at)).toEqual([100_000]);
      await s.appendSend('l', rec(100_001), 60_000);
      expect(await s.recentSends('l', 100_001)).toEqual([rec(100_001)]);
    });

    it('state round-trips and null deletes', async () => {
      const s = await make();
      expect(await s.getState('k')).toBeNull();
      await s.setState('k', '{"a":1}');
      expect(await s.getState('k')).toBe('{"a":1}');
      await s.setState('k', null);
      expect(await s.getState('k')).toBeNull();
    });

    it('100 concurrent checks against a budget of 25 admit exactly 25', async () => {
      const store = await make();
      const guard = createGuard({ store, clock: () => NOW, budgets: { perDay: 25 }, rate: { perMinute: 1000 }, loop: { mode: 'off' } });
      const results = await Promise.all(Array.from({ length: 100 }, (_, i) => guard.check({ to: `u${i}@example.com` })));
      expect(results.filter((d) => d.outcome === 'allow')).toHaveLength(25);
    });

    it('passes the budget, rate, approval and kill-switch vectors', async () => {
      const store = await make();
      for (const file of loadVectors().filter((f) => ['budgets', 'rate', 'approval', 'kill_switch', 'order', 'suppression', 'loop_modes'].includes(f.name))) {
        for (const c of file.cases) await runWithStore(c.steps, c.config, store);
      }
    });
  });
}
