import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('perDay 20 refuses the 21st send', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('keeps the upstream count at 20, including across a new guard on the same file', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const files = tempGuardFiles();
    const firstUpstream = await startFake(counts);
    const first = await connectHost(firstUpstream, guardFor(files, { perDay: 20 }, 'file'));
    for (let n = 1; n <= 20; n += 1) {
      const result = await first.client.callTool({
        name: 'send_email',
        arguments: { to: `user${n}@example.com`, subject: `Receipt ${n}`, text: `body ${n}` },
      });
      expect(result.isError).not.toBe(true);
    }
    await first.close();

    const secondUpstream = await startFake(counts);
    const second = await connectHost(secondUpstream, guardFor(files, { perDay: 20 }, 'file'));
    closers.push(second.close);
    const refused = await second.client.callTool({
      name: 'send_email',
      arguments: { to: 'user21@example.com', subject: 'Receipt 21', text: 'body 21' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('agent_budget_exceeded');
    expect(textOf(refused)).toContain('20');
    expect(counts.sendEmail).toBe(20);
  });
});
