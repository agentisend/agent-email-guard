import { describe, expect, it } from 'vitest';
import { ApprovalRequired, createGuard, GuardRefused } from '../src/index.js';

describe('wrap(): same signature, checks, sends, records', () => {
  it('passes arguments and result through, and records the send', async () => {
    const calls: unknown[][] = [];
    const guard = createGuard({ approval: { newRecipients: true } });
    const send = guard.wrap(async (msg: { to: string; subject: string; text: string }, opts?: { tag: string }) => {
      calls.push([msg, opts]);
      return { id: 'msg_1' };
    });
    await guard.record({ to: 'known@example.com' });
    await expect(send({ to: 'known@example.com', subject: 'Hi', text: 'x' }, { tag: 't' })).resolves.toEqual({ id: 'msg_1' });
    expect(calls).toEqual([[{ to: 'known@example.com', subject: 'Hi', text: 'x' }, { tag: 't' }]]);
  });

  it('throws GuardRefused carrying the decision and never calls the provider', async () => {
    let called = 0;
    const guard = createGuard({ suppress: ['@competitor.example'] });
    const send = guard.wrap(async (_m: { to: string }) => ++called);
    const err = await send({ to: 'sales@competitor.example' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardRefused);
    expect((err as GuardRefused).decision.reason).toBe('recipient_suppressed');
    expect((err as GuardRefused).message).toBe((err as GuardRefused).decision.message);
    expect(called).toBe(0);
  });

  it('ApprovalRequired.approve() re-checks without approval rules and sends', async () => {
    let called = 0;
    const guard = createGuard({ approval: { recipients: ['@bigco.com'] }, budgets: { perHour: 1 } });
    const send = guard.wrap(async (_m: { to: string }) => ({ n: ++called }));
    const err = (await send({ to: 'ceo@bigco.com' }).catch((e: unknown) => e)) as ApprovalRequired<{ n: number }>;
    expect(err).toBeInstanceOf(ApprovalRequired);
    expect(called).toBe(0);
    await expect(err.approve()).resolves.toEqual({ n: 1 });
    // The approved send spent the hourly budget of 1.
    await expect(err.approve()).rejects.toBeInstanceOf(GuardRefused);
  });

  it('releases the reservation and rethrows when the provider fails', async () => {
    const guard = createGuard({ budgets: { perHour: 1 } });
    let fail = true;
    const send = guard.wrap(async (_m: { to: string }) => {
      if (fail) throw new Error('provider 503');
      return 'ok';
    });
    await expect(send({ to: 'a@example.com' })).rejects.toThrow('provider 503');
    fail = false;
    await expect(send({ to: 'a@example.com' })).resolves.toBe('ok');
  });

  it('a failed provider call is not recorded for loop detection', async () => {
    const guard = createGuard();
    const send = guard.wrap(async (_m: { to: string; subject: string }) => {
      throw new Error('down');
    });
    for (let i = 0; i < 5; i++) await send({ to: 'a@example.com', subject: 'same' }).catch(() => undefined);
    expect((await guard.check({ to: 'a@example.com', subject: 'same' })).outcome).toBe('allow');
  });

  it('toGuardSend maps a provider-specific call', async () => {
    const guard = createGuard({ suppress: ['blocked@example.com'] });
    const send = guard.wrap(async (_input: { Destination: { ToAddresses: string[] } }) => 'sent', {
      toGuardSend: (input) => ({ to: input.Destination.ToAddresses }),
    });
    await expect(send({ Destination: { ToAddresses: ['blocked@example.com'] } })).rejects.toBeInstanceOf(GuardRefused);
  });
});
