import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface ResolvedConfig {
  readonly perDay: number;
  readonly perHour?: number;
  readonly perMinute?: number;
  readonly loopMode: 'off' | 'full';
  readonly approvalRecipients: readonly string[];
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

interface FileConfig {
  // The spec's policy file (SPEC section 2.9) uses snake_case; the camelCase names are kept for 0.1.0 files.
  budgets?: { per_day?: unknown; per_hour?: unknown; perDay?: unknown; perHour?: unknown };
  rate?: { per_minute?: unknown; perMinute?: unknown };
  loop?: { mode?: unknown };
  approval?: { recipients?: unknown };
  store?: { kind?: unknown; path?: unknown };
  controlFile?: unknown;
  approvalsFile?: unknown;
  key?: unknown;
  sendTools?: unknown;
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
  readonly loop?: 'off' | 'full';
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
        throw new Error('approve needs the id from agent-email-guard approvals.');
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
  let loop: 'off' | 'full' | undefined;
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
      throw new Error(`Unexpected argument ${token}. Run agent-email-guard --help.`);
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
        if (value !== 'off' && value !== 'full') throw new Error('--loop is off or full.');
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
        throw new Error(`Unknown flag ${token}. Run agent-email-guard --help.`);
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
  const file = filePath ? readConfigFile(filePath) : {};

  const perDay =
    flags.perDay ??
    numberField(file.budgets?.per_day, 'budgets.per_day') ??
    numberField(file.budgets?.perDay, 'budgets.perDay') ??
    100;
  const perHour =
    flags.perHour ??
    numberField(file.budgets?.per_hour, 'budgets.per_hour') ??
    numberField(file.budgets?.perHour, 'budgets.perHour');
  const perMinute =
    flags.perMinute ??
    numberField(file.rate?.per_minute, 'rate.per_minute') ??
    numberField(file.rate?.perMinute, 'rate.perMinute');
  const loopMode = flags.loop ?? loopField(file.loop?.mode) ?? 'full';
  const approvalRecipients = stringList(file.approval?.recipients);
  const store = flags.store ?? (file.store?.kind === 'file' ? 'file' : 'memory');
  const storePath = abs(cwd, flags.storePath ?? stringField(file.store?.path) ?? resolve(dir, 'store.json'));
  const controlFile = abs(cwd, flags.controlFile ?? stringField(file.controlFile) ?? resolve(dir, 'control.json'));
  const approvalsFile = abs(cwd, flags.approvalsFile ?? stringField(file.approvalsFile) ?? resolve(dir, 'approvals.json'));
  const key = flags.key ?? stringField(file.key);
  const sendTools = flags.sendTools !== undefined ? splitList(flags.sendTools) : stringListOrNull(file.sendTools);

  return {
    perDay,
    ...(perHour !== undefined ? { perHour } : {}),
    ...(perMinute !== undefined ? { perMinute } : {}),
    loopMode,
    approvalRecipients,
    store,
    storePath,
    controlFile,
    approvalsFile,
    ...(key !== undefined ? { key } : {}),
    sendTools,
    ...(flags.wrap !== undefined ? { wrap: flags.wrap } : {}),
    ...(flags.wrapUrl !== undefined ? { wrapUrl: flags.wrapUrl } : {}),
    headers: parseHeaders(flags.headers, env),
  };
}

function readConfigFile(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the file must be a JSON object');
    }
    return parsed as FileConfig;
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
}

function numberField(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number.`);
  }
  return value;
}

function loopField(value: unknown): 'off' | 'full' | undefined {
  if (value === undefined) return undefined;
  if (value === 'off' || value === 'full') return value;
  throw new Error('loop.mode is off or full.');
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('approval.recipients must be a list of strings.');
  }
  return value as string[];
}

function stringListOrNull(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('sendTools must be a list of strings.');
  }
  return value as string[];
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
