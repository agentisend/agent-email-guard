import { afterEach, describe, expect, it } from 'vitest';
import { connectHost, guardFor, startFake, tempGuardFiles, textOf, type FakeCounts } from './harness.js';

describe('non-send tools pass through untouched', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('forwards list_labels, resources, and prompts when the daily ceiling is 0', async () => {
    const counts: FakeCounts = { sendEmail: 0, sendBatch: 0, listLabels: 0, failSendEmail: 0 };
    const upstream = await startFake(counts);
    const opened = await connectHost(upstream, guardFor(tempGuardFiles(), { perDay: 0 }));
    closers.push(opened.close);
    const labels = await opened.client.callTool({ name: 'list_labels', arguments: {} });
    expect(labels.isError).not.toBe(true);
    expect(textOf(labels)).toBe('inbox');
    expect(counts.listLabels).toBe(1);
    const resources = await opened.client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain('fake://labels');
    const prompts = await opened.client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain('draft');
    const send = await opened.client.callTool({
      name: 'send_email',
      arguments: { to: 'a@example.com', subject: 'No', text: 'nope' },
    });
    expect(send.isError).toBe(true);
    expect(counts.sendEmail).toBe(0);
  });
});
