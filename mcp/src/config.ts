import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { GuardConfig } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';

export interface ResolvedConfig {
  readonly guard: GuardConfig;
  readonly store: 'memory' | 'file';
  readonly storePath: string;
  readonly controlFile: string;
  readonly approvalsFile: string;
  readonly key?: string;
  readonly sendTools: readonly string[] | null;
  readonly wrap?: string;
  readonly wrapUrl?: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CliFlags {
  readonly help: boolean;
  readonly command: 'serve' | 'pause' | 'resume' | 'approvals' | 'approve' | 'hook';
  readonly approveId?: string;
  readonly hookAction?: 'install' | 'uninstall' | 'status' | 'run';
  readonly userScope: boolean;
  readonly wrap?: string;
  readonly wrapUrl?: string;
  readonly headers: readonly string[];
  readonly sendTools?: string;
  readonly key?: string;
  readonly configPath?: string;
  readonly perDay?: number;
  readonly perHour?: number;
  readonly perMinute?: number;
  readonly loop?: 'off' | 'full' | 'repetition_only';
  readonly store?: 'memory' | 'file';
  readonly storePath?: string;
  readonly controlFile?: string;
  readonly approvalsFile?: string;
}

export function parseArgs(argv: readonly string[]): CliFlags {
  let command: CliFlags['command'] = 'serve';
  let approveId: string | undefined;
  let hookAction: CliFlags['hookAction'];
  const rest = [...argv];
  const head = rest[0];
  if (head === 'mcp') rest.shift();
  const next = rest[0];
  if (next === 'pause' || next === 'resume' || next === 'approvals' || next === 'approve' || next === 'hook') {
    command = next === 'hook' ? 'serve' : next;
    rest.shift();
    if (next === 'approve') {
      approveId = rest.shift();
      if (!approveId || approveId.startsWith('--')) {
        throw new Error('approve needs the id from agent-email-guard-mcp approvals.');
      }
    }
    if (next === 'hook') {
      const action = rest.shift();
      if (action !== 'install' && action !== 'uninstall' && action !== 'status' && action !== 'run') {
        throw new Error('hook needs install, uninstall, status, or run.');
      }
      hookAction = action;
      command = 'hook';
    }
  }

  let help = false;
  let wrap: string | undefined;
  let wrapUrl: string | undefined;
  const headers: string[] = [];
  let sendTools: string | undefined;
  let key: string | undefined;
  let configPath: string | undefined;
  let perDay: number | undefined;
  let perHour: number | undefined;
  let perMinute: number | undefined;
  let loop: 'off' | 'full' | 'repetition_only' | undefined;
  let store: 'memory' | 'file' | undefined;
  let storePath: string | undefined;
  let controlFile: string | undefined;
  let approvalsFile: string | undefined;
  let userScope = false;

  const take = (flag: string, index: number): string => {
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value.`);
    }
    return value;
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--user') {
      userScope = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument ${token}. Run agent-email-guard-mcp --help.`);
    }
    const value = take(token, i);
    i += 1;
    switch (token) {
      case '--wrap':
        wrap = value;
        break;
      case '--wrap-url':
        wrapUrl = value;
        break;
      case '--header':
        headers.push(value);
        break;
      case '--send-tools':
        sendTools = value;
        break;
      case '--key':
        key = value;
        break;
      case '--config':
        configPath = value;
        break;
      case '--per-day':
        perDay = integerFlag(token, value);
        break;
      case '--per-hour':
        perHour = integerFlag(token, value);
        break;
      case '--per-minute':
        perMinute = integerFlag(token, value);
        break;
      case '--loop':
        if (value !== 'off' && value !== 'full' && value !== 'repetition_only') {
          throw new Error('--loop is off, full, or repetition_only.');
        }
        loop = value;
        break;
      case '--store':
        if (value !== 'memory' && value !== 'file') throw new Error('--store is memory or file.');
        store = value;
        break;
      case '--store-path':
        storePath = value;
        break;
      case '--control':
        controlFile = value;
        break;
      case '--approvals':
        approvalsFile = value;
        break;
      default:
        throw new Error(`Unknown flag ${token}. Run agent-email-guard-mcp --help.`);
    }
  }

  return {
    help,
    command,
    userScope,
    ...(hookAction !== undefined ? { hookAction } : {}),
    ...(approveId !== undefined ? { approveId } : {}),
    ...(wrap !== undefined ? { wrap } : {}),
    ...(wrapUrl !== undefined ? { wrapUrl } : {}),
    headers,
    ...(sendTools !== undefined ? { sendTools } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(perDay !== undefined ? { perDay } : {}),
    ...(perHour !== undefined ? { perHour } : {}),
    ...(perMinute !== undefined ? { perMinute } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(store !== undefined ? { store } : {}),
    ...(storePath !== undefined ? { storePath } : {}),
    ...(controlFile !== undefined ? { controlFile } : {}),
    ...(approvalsFile !== undefined ? { approvalsFile } : {}),
  };
}

function integerFlag(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} takes a whole number.`);
  return Number(value);
}

export function loadConfig(flags: CliFlags, cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const dir = resolve(cwd, '.agent-email-guard');
  const filePath = flags.configPath
    ? resolve(cwd, flags.configPath)
    : existsSync(resolve(cwd, 'agent-email-guard.json'))
      ? resolve(cwd, 'agent-email-guard.json')
      : undefined;
  const fromFile = filePath ? loadPolicy(filePath) : {};
  const budgets = {
    ...(fromFile.budgets ?? {}),
    ...(flags.perDay !== undefined ? { perDay: flags.perDay } : {}),
    ...(flags.perHour !== undefined ? { perHour: flags.perHour } : {}),
  };
  const rate = {
    ...(fromFile.rate ?? {}),
    ...(flags.perMinute !== undefined ? { perMinute: flags.perMinute } : {}),
  };
  const loop = {
    ...(fromFile.loop ?? {}),
    ...(flags.loop !== undefined ? { mode: flags.loop } : {}),
  };
  const key = flags.key ?? fromFile.key;
  const guard: GuardConfig = {
    ...fromFile,
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
    ...(Object.keys(rate).length > 0 ? { rate } : {}),
    ...(Object.keys(loop).length > 0 ? { loop } : {}),
    ...(key !== undefined ? { key } : {}),
  };

  return {
    guard,
    store: flags.store ?? 'memory',
    storePath: abs(cwd, flags.storePath ?? resolve(dir, 'store.json')),
    controlFile: abs(cwd, flags.controlFile ?? resolve(dir, 'control.json')),
    approvalsFile: abs(cwd, flags.approvalsFile ?? resolve(dir, 'approvals.json')),
    ...(key !== undefined ? { key } : {}),
    sendTools: flags.sendTools !== undefined ? splitList(flags.sendTools) : null,
    ...(flags.wrap !== undefined ? { wrap: flags.wrap } : {}),
    ...(flags.wrapUrl !== undefined ? { wrapUrl: flags.wrapUrl } : {}),
    headers: parseHeaders(flags.headers, env),
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function abs(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Header values are copied through. `${VAR}` is read from the environment so a config file can stay free of the key. */
export function parseHeaders(raw: readonly string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const splitAt = entry.indexOf(':');
    if (splitAt <= 0) throw new Error(`--header must look like "Name: value". Got ${entry}.`);
    const name = entry.slice(0, splitAt).trim();
    const value = expandEnv(entry.slice(splitAt + 1).trim(), env);
    headers[name] = value;
  }
  return headers;
}

function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '');
}
