import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('stdout carries nothing but protocol', () => {
  it('speaks JSON-RPC on stdout and keeps the body off stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-stdio-'));
    const root = join(import.meta.dirname, '..');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        join(root, 'src/cli.ts'),
        '--wrap',
        `${process.execPath} --import tsx ${join(root, 'test/fixtures/fake-stdio.ts')}`,
        '--per-day',
        '5',
        '--key',
        'stdio-test',
        '--store',
        'memory',
        '--control',
        join(dir, 'control.json'),
        '--approvals',
        join(dir, 'approvals.json'),
      ],
      cwd: root,
      stderr: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const client = new Client({ name: 'host', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    const body = 'SECRET-BODY-DO-NOT-LOG';
    const result = await client.callTool({
      name: 'send_email',
      arguments: { to: 'person@example.com', subject: 'Hi', text: body },
    });
    expect(result.isError).not.toBe(true);
    expect(stderr).not.toContain(body);
    expect(stderr).not.toContain('person@example.com');
    expect(stderr).toContain('"outcome":"allow"');
    expect(stderr).toContain('"reason":"ok"');
    const parsed = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { recipients?: string[] });
    expect(parsed[0]?.recipients?.[0]).toMatch(/^[a-f0-9]{64}$/);
    await client.close();
    writeFileSync(join(dir, 'stderr.txt'), stderr);
    expect(readFileSync(join(dir, 'stderr.txt'), 'utf8')).toBe(stderr);
  });
});
