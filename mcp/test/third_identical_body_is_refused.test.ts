import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('the third identical body is refused', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('forwards the first two and does not call upstream on the third', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const upstream = await startFake(counts);
    const opened = await connectHost(upstream, guardFor(tempGuardFiles(), { perDay: 20 }));
    closers.push(opened.close);
    const args = { to: 'a@example.com', subject: 'Receipt', text: 'same-body' };
    expect((await opened.client.callTool({ name: 'send_email', arguments: args })).isError).not.toBe(true);
    expect((await opened.client.callTool({ name: 'send_email', arguments: args })).isError).not.toBe(true);
    const third = await opened.client.callTool({ name: 'send_email', arguments: args });
    expect(third.isError).toBe(true);
    expect(textOf(third)).toContain('loop_repetition_detected');
    expect(counts.sendEmail).toBe(2);
  });
});
