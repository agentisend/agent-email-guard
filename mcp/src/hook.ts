import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { classifyCall } from './classify.js';
import { loadConfig, parseArgs } from './config.js';
import { decisionLine, toolErrorText } from './log.js';
import { openGuard } from './runtime.js';
import type { ResolvedConfig } from './config.js';
import type { CheckedSend } from './runtime.js';

/**
 * PreToolUse matcher. Claude Code tests this with JavaScript
 * `RegExp.prototype.test` because it contains characters outside the
 * exact-match set (code.claude.com/docs/en/hooks, fetched 2026-11-09).
 * `test` is unanchored, so this hits `mcp__<server>__…send|email|mail…`,
 * including plugin-scoped names. The script still classifies; a name
 * that only looks like mail (`list_emails`) is not counted and not denied.
 */
export const HOOK_MATCHER = 'mcp__.*__.*(send|email|mail|Send|Email|Mail).*';

export const hookMatcher = new RegExp(HOOK_MATCHER);

export interface HookHandlerJson {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
  onFailure: 'block';
}

/**
 * Exec form that does not embed a path under npm's `_npx` cache.
 * `npx --yes agent-email-guard-mcp@0.2` works whether or not the package is installed: most people run
 * `npx agent-email-guard hook install` without installing anything, and `--no-install` would then fail
 * every call, which `onFailure: block` turns into blocking every email tool. npx reuses its cache after
 * the first run; anything it prints goes to stderr, which Claude Code ignores on exit 0.
 */
export const HOOK_PACKAGE_SPEC = 'agent-email-guard-mcp@0.2';
export const HOOK_ARGS = ['--yes', HOOK_PACKAGE_SPEC, 'hook', 'run'] as const;

export function hookHandler(): HookHandlerJson {
  return {
    type: 'command',
    command: 'npx',
    args: [...HOOK_ARGS],
    timeout: 30,
    onFailure: 'block',
  };
}

export function isOurHook(handler: unknown): boolean {
  if (handler === null || typeof handler !== 'object') return false;
  const row = handler as { command?: unknown; args?: unknown };
  if (typeof row.command !== 'string') return false;
  const args = Array.isArray(row.args) ? row.args.map(String) : [];
  if (row.command === 'npx' && args.some((a) => a.startsWith('agent-email-guard-mcp')) && args.at(-2) === 'hook' && args.at(-1) === 'run') {
    return true;
  }
  // 0.1.0 wrote `node <cli path> hook run`, often a path inside the npx cache.
  if (args.at(-2) === 'hook' && args.at(-1) === 'run' && args.join(' ').includes('agent-email-guard')) return true;
  return row.command.includes('agent-email-guard') && row.command.includes('hook run');
}

export function settingsFile(userScope: boolean, cwd: string, home = homedir()): string {
  return userScope ? resolve(home, '.claude', 'settings.json') : resolve(cwd, '.claude', 'settings.json');
}

export function installHook(settingsPath: string): void {
  const settings = readSettings(settingsPath);
  const hooks = objectField(settings, 'hooks');
  const groups: Record<string, unknown>[] = arrayField(hooks, 'PreToolUse').flatMap((group) => {
    const handlers = arrayField(group, 'hooks').filter((handler) => !isOurHook(handler));
    if (handlers.length === 0) return [];
    return [{ ...group, hooks: handlers }];
  });
  groups.push({ matcher: HOOK_MATCHER, hooks: [hookHandler()] } as Record<string, unknown>);
  hooks['PreToolUse'] = groups;
  settings['hooks'] = hooks;
  writeSettings(settingsPath, settings);
}

export function uninstallHook(settingsPath: string): boolean {
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const hooks = settings['hooks'];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const hookObj = hooks as Record<string, unknown>;
  const groups = arrayField(hookObj, 'PreToolUse');
  let removed = false;
  const kept = groups.flatMap((group) => {
    const handlers = arrayField(group, 'hooks').filter((handler) => {
      if (!isOurHook(handler)) return true;
      removed = true;
      return false;
    });
    if (handlers.length === 0) return [];
    return [{ ...group, hooks: handlers }];
  });
  if (kept.length === 0) delete hookObj['PreToolUse'];
  else hookObj['PreToolUse'] = kept;
  if (Object.keys(hookObj).length === 0) delete settings['hooks'];
  writeSettings(settingsPath, settings);
  return removed;
}

export function hookStatus(settingsPath: string): { installed: boolean; path: string; matcher: string | null } {
  try {
    const settings = readSettings(settingsPath);
    const hooks = settings['hooks'];
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
      return { installed: false, path: settingsPath, matcher: null };
    }
    for (const group of arrayField(hooks as Record<string, unknown>, 'PreToolUse')) {
      if (arrayField(group, 'hooks').some((handler) => isOurHook(handler))) {
        const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : null;
        return { installed: true, path: settingsPath, matcher };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { installed: false, path: settingsPath, matcher: null };
}

export interface HookResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One PreToolUse invocation. Exit 0. Stdout is either empty (not a send)
 * or one JSON object whose `permissionDecision` is `allow` or `deny`.
 * Claude Code's docs (2026-11-09): exit 0 plus that JSON is how a
 * PreToolUse hook decides; `deny` is shown to the model; `allow` skips
 * the permission prompt except where the docs list an exception.
 * This function does not read `permission_mode` and does not claim a
 * mode was tested.
 */
export async function evaluateHook(raw: string, cwd: string): Promise<HookResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return deny('The hook could not read the tool call, so the send was not allowed. hook_input_invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deny('The hook could not read the tool call, so the send was not allowed. hook_input_invalid');
  }
  const input = parsed as Record<string, unknown>;
  const toolName = typeof input['tool_name'] === 'string' ? input['tool_name'] : '';
  const toolInput = input['tool_input'];
  const args =
    toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};
  const dir = typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : cwd;
  const named = mcpTool(toolName);
  const config = hookConfig(dir);
  const key =
    config.key ??
    mcpServerName(input['mcp_server']) ??
    named.server ??
    'mcp';
  const classified = classifyCall(named.name, args, key, config.sendTools === null ? null : new Set(config.sendTools));
  if (classified.kind === 'pass') return { exitCode: 0, stdout: '', stderr: '' };

  const guard = openGuard(config);
  const lines: string[] = [];
  const reserved: CheckedSend[] = [];
  for (const send of classified.messages) {
    const decision = await guard.check(send);
    lines.push(decisionLine(decision, send.key ?? key));
    if (decision.outcome !== 'allow') {
      for (const prior of reserved) await guard.release(prior);
      return deny(toolErrorText(decision), lines.join('\n'));
    }
    reserved.push(decision);
  }
  for (const decision of reserved) await guard.record(decision);
  const reason = reserved[0] ? toolErrorText(reserved[0]) : 'Send reserved. ok';
  return {
    exitCode: 0,
    stdout: decisionJson('allow', reason),
    stderr: lines.length > 0 ? `${lines.join('\n')}\n` : '',
  };
}

function hookConfig(cwd: string): ResolvedConfig {
  const loaded = loadConfig(parseArgs([]), cwd);
  return { ...loaded, store: 'file' };
}

function mcpTool(toolName: string): { server?: string; name: string } {
  if (!toolName.startsWith('mcp__')) return { name: toolName };
  const parts = toolName.split('__');
  if (parts.length < 3) return { name: toolName };
  const server = parts[1];
  return {
    ...(server !== undefined && server.length > 0 ? { server } : {}),
    name: parts.slice(2).join('__'),
  };
}

function mcpServerName(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function decisionJson(permissionDecision: 'allow' | 'deny', reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason: reason,
    },
  })}\n`;
}

function deny(reason: string, stderr = ''): HookResult {
  return {
    exitCode: 0,
    stdout: decisionJson('deny', reason),
    stderr: stderr.length > 0 ? `${stderr.replace(/\n$/, '')}\n` : '',
  };
}

function readSettings(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (text.trim().length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

function objectField(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function arrayField(parent: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = parent[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
}
