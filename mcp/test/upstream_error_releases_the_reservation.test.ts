import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('an upstream error releases the reservation', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('lets the next send through a perDay of 1 after the first call fails upstream', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 1 };
    const upstream = await startFake(counts);
    const opened = await connectHost(upstream, guardFor(tempGuardFiles(), { perDay: 1 }));
    closers.push(opened.close);
    const failed = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'a@example.com', subject: 'One', text: 'first' },
    });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('upstream failed');
    expect(counts.sendEmail).toBe(1);
    const sent = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'a@example.com', subject: 'Two', text: 'second' },
    });
    expect(sent.isError).not.toBe(true);
    expect(counts.sendEmail).toBe(2);
    const refused = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'a@example.com', subject: 'Three', text: 'third' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('agent_budget_exceeded');
    expect(counts.sendEmail).toBe(2);
  });
});
