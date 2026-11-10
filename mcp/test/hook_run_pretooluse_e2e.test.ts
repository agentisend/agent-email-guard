/**
 * A PreToolUse payload in the shape Claude Code writes (hook_event_name,
 * tool_name, tool_input, tool_use_id, cwd, permission_mode, mcp_server)
 * piped into `hook run`. Stdout is one JSON object.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function runHook(dir: string, input: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'hook', 'run'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

describe('hook run reads a real PreToolUse payload', () => {
  it('denies the send on stdout and does not echo the body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-e2e-'));
    writeFileSync(join(dir, 'agent-email-guard.json'), JSON.stringify({ version: 1, budgets: { per_day: 0 } }));
    const secret = 'SECRET-BODY-DO-NOT-LOG';
    const result = await runHook(dir, {
      session_id: 'sess_test',
      transcript_path: join(dir, 'transcript.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__resend__send-email',
      tool_use_id: 'toolu_01ABC',
      mcp_server: { name: 'resend', source: 'user' },
      tool_input: {
        to: 'person@example.com',
        subject: 'Hi',
        text: secret,
        html: `<p>${secret}</p>`,
      },
    });
    expect(result.code).toBe(0);
    const trimmed = result.stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    expect(trimmed.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('agent_budget_exceeded');
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain('person@example.com');
    expect(result.stderr).not.toContain('person@example.com');
  });
});