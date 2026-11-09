import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('allowed sends forward', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('forwards send_email and returns the upstream text', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const upstream = await startFake(counts);
    const opened = await connectHost(upstream, guardFor(tempGuardFiles(), { perDay: 20 }));
    closers.push(opened.close);
    const result = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'a@example.com', subject: 'Receipt', text: 'one' },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe('queued');
    expect(counts.sendEmail).toBe(1);
    expect(opened.client.getInstructions()).toBe('Fake upstream. Sends nothing.');
  });
});
