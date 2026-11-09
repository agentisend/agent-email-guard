import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { run } from '../src/cli.js';
import {
  evaluateHook,
  hookMatcher,
  HOOK_MATCHER,
  hookStatus,
  installHook,
  settingsFile,
  uninstallHook,
} from '../src/hook.js';

const root = join(import.meta.dirname, '..');

function project(): string {
  return mkdtempSync(join(tmpdir(), 'agent-email-guard-hook-'));
}

function writePolicy(dir: string, policy: Record<string, unknown>): void {
  writeFileSync(join(dir, 'agent-email-guard.json'), JSON.stringify(policy));
}

function call(tool: string, args: Record<string, unknown>, cwd: string): Promise<{ decision: string; reason: string; stdout: string }> {
  return evaluateHook(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: args,
      cwd,
      permission_mode: 'default',
    }),
    cwd,
  ).then((result) => {
    expect(result.exitCode).toBe(0);
    if (result.stdout.trim().length === 0) return { decision: '', reason: '', stdout: result.stdout };
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; hookEventName: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
    return {
      decision: parsed.hookSpecificOutput.permissionDecision,
      reason: parsed.hookSpecificOutput.permissionDecisionReason,
      stdout: result.stdout,
    };
  });
}

describe('Claude Code PreToolUse hook', () => {
  it('matches send-like MCP tool names the way Claude Code tests a matcher', () => {
    expect(hookMatcher.test('mcp__resend__send-email')).toBe(true);
    expect(hookMatcher.test('mcp__gmail__send_email')).toBe(true);
    expect(hookMatcher.test('mcp__agentisend__send_batch')).toBe(true);
    expect(hookMatcher.test('mcp__plugin_my-plugin_db__send_email')).toBe(true);
    expect(hookMatcher.test('mcp__gmail__list_labels')).toBe(false);
    expect(HOOK_MATCHER).toMatch(/\.\*/);
  });

  it('installs into project settings, keeps other keys, and uninstall removes only this hook', () => {
    const dir = project();
    const path = settingsFile(false, dir);
    writeFileSync(join(dir, '.claude-skip'), '');
    installHook(path, join(root, 'src/cli.ts'));
    const other = { hooks: [{ type: 'command', command: 'echo keep' }] };
    const settings = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; args: string[]; onFailure: string }> }> };
    };
    settings.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [other.hooks[0] as unknown as { command: string; args: string[]; onFailure: string }],
    });
    writeFileSync(path, JSON.stringify(settings));
    installHook(path, join(root, 'src/cli.ts'));
    const twice = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: unknown[] }> };
    };
    const ours = twice.hooks.PreToolUse.filter((group) => group.matcher === HOOK_MATCHER);
    expect(ours).toHaveLength(1);
    expect(twice.hooks.PreToolUse.some((group) => group.matcher === 'Bash')).toBe(true);
    const handler = ours[0]?.hooks[0] as { command: string; args: string[]; onFailure: string };
    expect(handler.command).toBe(process.execPath);
    expect(handler.args.slice(-2)).toEqual(['hook', 'run']);
    expect(handler.onFailure).toBe('block');
    expect(hookStatus(path).installed).toBe(true);
    expect(uninstallHook(path)).toBe(true);
    const after = JSON.parse(readFileSync(path, 'utf8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(after.hooks.PreToolUse.map((group) => group.matcher)).toEqual(['Bash']);
    expect(hookStatus(path).installed).toBe(false);
  });

  it('hook install and hook status go through the CLI', async () => {
    const dir = project();
    let out = '';
    expect(await run(['hook', 'install'], { cwd: dir, stdout: (line) => { out += line; } })).toBe(0);
    expect(out).toContain('installed');
    expect(hookStatus(settingsFile(false, dir)).installed).toBe(true);
    out = '';
    expect(await run(['hook', 'status'], { cwd: dir, stdout: (line) => { out += line; } })).toBe(0);
    expect(out).toContain('matcher');
    expect(out).toContain(HOOK_MATCHER);
    expect(settingsFile(true, dir, join(dir, 'home'))).toBe(join(dir, 'home', '.claude', 'settings.json'));
  });

  it('allows a send, records it, and denies the 21st without running a server', async () => {
    const dir = project();
    writePolicy(dir, { budgets: { perDay: 20 }, store: { kind: 'file', path: join(dir, 'store.json') } });
    for (let n = 1; n <= 20; n += 1) {
      const result = await call('mcp__resend__send-email', { to: 'a@example.com', subject: `S${n}`, text: `body ${n}` }, dir);
      expect(result.decision).toBe('allow');
    }
    const refused = await call('mcp__resend__send-email', { to: 'a@example.com', subject: 'S21', text: 'body 21' }, dir);
    expect(refused.decision).toBe('deny');
    expect(refused.reason).toContain('agent_budget_exceeded');
    expect(refused.reason).toContain('20');
  });

  it('denies the third identical body', async () => {
    const dir = project();
    writePolicy(dir, { budgets: { perDay: 20 } });
    const args = { to: 'a@example.com', subject: 'Receipt', text: 'same-body' };
    expect((await call('mcp__gmail__send_email', args, dir)).decision).toBe('allow');
    expect((await call('mcp__gmail__send_email', args, dir)).decision).toBe('allow');
    const third = await call('mcp__gmail__send_email', args, dir);
    expect(third.decision).toBe('deny');
    expect(third.reason).toContain('loop_repetition_detected');
  });

  it('denies a held send with approval required, then allows it after approve', async () => {
    const dir = project();
    writePolicy(dir, {
      budgets: { perDay: 20 },
      approval: { recipients: ['vip@example.com'] },
      approvalsFile: join(dir, 'approvals.json'),
    });
    const args = { to: ['vip@example.com'], subject: 'Hi', body: 'hello' };
    const held = await call('mcp__agentisend__send_email', args, dir);
    expect(held.decision).toBe('deny');
    expect(held.reason).toContain('approval required');
    const id = held.reason.match(/ap_[a-f0-9]+/)?.[0] ?? '';
    expect(await run(['approve', id, '--approvals', join(dir, 'approvals.json')], { cwd: dir, stdout: () => undefined })).toBe(0);
    expect((await call('mcp__agentisend__send_email', args, dir)).decision).toBe('allow');
  });

  it('does not deny or count a non-send, and a batch of 2 spends 2', async () => {
    const dir = project();
    writePolicy(dir, { budgets: { perDay: 2 } });
    const labels = await call('mcp__gmail__list_labels', {}, dir);
    expect(labels.decision).toBe('');
    expect(labels.stdout).toBe('');
    const batch = await call(
      'mcp__agentisend__send_batch',
      {
        emails: [
          { to: 'a@example.com', subject: 'One', text: 'alpha' },
          { to: 'b@example.com', subject: 'Two', text: 'beta' },
        ],
      },
      dir,
    );
    expect(batch.decision).toBe('allow');
    const extra = await call('mcp__agentisend__send_email', { to: 'c@example.com', subject: 'Three', text: 'gamma' }, dir);
    expect(extra.decision).toBe('deny');
    expect(extra.reason).toContain('agent_budget_exceeded');
  });

  it('prints only the decision JSON on stdout', async () => {
    const dir = project();
    writePolicy(dir, { budgets: { perDay: 5 }, key: 'hook-stdio' });
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__resend__send-email',
      tool_input: { to: 'person@example.com', subject: 'Hi', text: 'SECRET-BODY-DO-NOT-LOG' },
      cwd: dir,
    });
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'hook', 'run'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(input);
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    expect(code).toBe(0);
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    expect(out.trim().startsWith('{')).toBe(true);
    expect(out.trim().endsWith('}')).toBe(true);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out).not.toContain('SECRET-BODY-DO-NOT-LOG');
    expect(err).not.toContain('SECRET-BODY-DO-NOT-LOG');
    expect(err).not.toContain('person@example.com');
  });
});
