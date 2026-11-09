import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('a held send forwards only after approve', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('does not call upstream until agent-email-guard approve <id>', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const files = tempGuardFiles();
    const upstream = await startFake(counts);
    const opened = await connectHost(
      upstream,
      guardFor(files, { perDay: 20, approvalRecipients: ['vip@example.com'] }),
    );
    closers.push(opened.close);
    const args = { to: 'vip@example.com', subject: 'Hi', text: 'body' };
    const held = await opened.client.callTool({ name: 'send_email', arguments: args });
    expect(held.isError).toBe(true);
    const heldText = textOf(held);
    expect(heldText).toContain('approval required');
    expect(heldText).toContain('recipient_requires_approval');
    expect(counts.sendEmail).toBe(0);
    const id = heldText.match(/ap_[a-f0-9]+/)?.[0];
    expect(id).toBeTruthy();

    let listed = '';
    const listCode = await run(['approvals', '--approvals', files.approvals], {
      cwd: files.dir,
      stdout: (line) => {
        listed += line;
      },
    });
    expect(listCode).toBe(0);
    expect(listed).toContain(id);

    const approveCode = await run(['approve', id ?? '', '--approvals', files.approvals], {
      cwd: files.dir,
      stdout: () => undefined,
    });
    expect(approveCode).toBe(0);

    const sent = await opened.client.callTool({ name: 'send_email', arguments: args });
    expect(sent.isError).not.toBe(true);
    expect(counts.sendEmail).toBe(1);
  });
});
