import { describe, expect, it } from 'vitest';
import { createGuard, MemoryStore } from '../src/index.js';

const s = { to: 'a@example.com', subject: 'Hi', text: 'x' };

describe('kill switch: blocks sends and never auto-resumes', () => {
  it('refuses every send while paused, with who/when/why', async () => {
    let now = 1000;
    const guard = createGuard({ clock: () => now });
    expect((await guard.check(s)).outcome).toBe('allow');
    await guard.killSwitch.pause('Agent was looping on one recipient.', 'operator-7');
    now = 5000;
    const d = await guard.check(s);
    expect(d.reason).toBe('kill_switch_active');
    expect(d.evidence).toEqual({ paused_at: 1000, paused_by: 'operator-7', pause_reason: 'Agent was looping on one recipient.' });
  });

  it('never resumes on a timer', async () => {
    let now = 1000;
    const guard = createGuard({ clock: () => now });
    await guard.killSwitch.pause('Entropy collapse detected.');
    now += 365 * 24 * 3_600_000;
    expect((await guard.killSwitch.state()).paused).toBe(true);
    expect((await guard.check(s)).reason).toBe('kill_switch_active');
  });

  it('resumes only through resume(), and keeps the cleared pause for audit', async () => {
    let now = 1000;
    const store = new MemoryStore();
    const guard = createGuard({ clock: () => now, store });
    await guard.killSwitch.pause('Loop suspected.', 'operator-7');
    now = 86_400_000;
    expect(await guard.killSwitch.resume('operator-3')).toBe(true);
    expect((await guard.check(s)).outcome).toBe('allow');
    expect(JSON.parse((await store.getState('agent-email-guard:kill:last_resume')) ?? '{}')).toEqual({ paused_at: 1000, paused_by: 'operator-7', reason: 'Loop suspected.', resumed_at: 86_400_000, resumed_by: 'operator-3' });
  });

  it('a redundant resume returns false and records nothing', async () => {
    const store = new MemoryStore();
    const guard = createGuard({ store });
    expect(await guard.killSwitch.resume('op')).toBe(false);
    expect(await store.getState('agent-email-guard:kill:last_resume')).toBeNull();
  });

  it('pausing stops every key, and two guards on one store share the switch', async () => {
    const store = new MemoryStore();
    const a = createGuard({ store, key: 'agent-a' });
    const b = createGuard({ store, key: 'agent-b' });
    await a.killSwitch.pause('stop all');
    expect((await b.check(s)).reason).toBe('kill_switch_active');
    expect((await a.check({ ...s, key: 'other' })).reason).toBe('kill_switch_active');
  });
});
