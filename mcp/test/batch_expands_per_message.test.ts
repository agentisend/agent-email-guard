import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('a batch expands to one guard check per message', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('counts two messages toward perDay 2 and does not call upstream for the next send', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const upstream = await startFake(counts);
    const opened = await connectHost(upstream, guardFor(tempGuardFiles(), { perDay: 2 }));
    closers.push(opened.close);
    const batch = await opened.client.callTool({
      name: 'send_batch',
      arguments: {
        emails: [
          { to: 'a@example.com', subject: 'One', text: 'alpha' },
          { to: 'b@example.com', subject: 'Two', text: 'beta' },
        ],
      },
    });
    expect(batch.isError).not.toBe(true);
    expect(counts.sendBatch).toBe(1);
    const extra = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'c@example.com', subject: 'Three', text: 'gamma' },
    });
    expect(extra.isError).toBe(true);
    expect(textOf(extra)).toContain('agent_budget_exceeded');
    expect(counts.sendEmail).toBe(0);
    expect(counts.sendBatch).toBe(1);
  });
});
