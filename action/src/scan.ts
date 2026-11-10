/**
 * Static scan for email sends in agent code.
 * A hit is reported when the file is in scope, the call is code (not a comment or a string),
 * the file does not import agent-email-guard, and no agent-email-guard.json covers its directory.
 * The scan reads the filesystem only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { langOf, splitCode, type CapturedModule, type Lang } from './mask.js';
import { isAgentSpecifier, isGuardSpecifier, phpSpecifiers, pythonSpecifiers, type Specifier } from './modules.js';

export const POLICY_FILENAME = 'agent-email-guard.json';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.php', '.go']);
const JSON_EXT = new Set(['.json', '.jsonc']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'vendor',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
]);

/** Files larger than this are skipped. A generated bundle is not a source file an agent wrote. */
export const MAX_BYTES = 1_000_000;

const DOT = String.raw`(?:\.|->)`;

type Rule = { id: string; re: RegExp; when?: 'mailgun' | 'sendgrid' };

const RULES: Rule[] = [
  { id: 'resend.emails.send', re: new RegExp(String.raw`\bresend\s*${DOT}\s*[Ee]mails\s*${DOT}\s*[Ss]end\b`, 'g') },
  { id: 'nodemailer.sendMail', re: /\bsendMail\s*\(/g },
  { id: 'nodemailer.createTransport', re: /\bcreateTransport\s*\(/g },
  { id: 'ses.SendRawEmail', re: /\bSendRawEmail(?:Command)?\b/g },
  { id: 'ses.SendEmail', re: /\bSendEmail(?:Command)?\b/g },
  { id: 'ses.send_raw_email', re: new RegExp(String.raw`${DOT}\s*send_raw_email\s*\(`, 'g') },
  { id: 'ses.send_email', re: new RegExp(String.raw`${DOT}\s*send_email\s*\(`, 'g') },
  { id: 'sendgrid.sgMail.send', re: /\bsgMail\s*\.\s*send\b/g },
  { id: 'mailgun.messages.create', re: new RegExp(String.raw`\bmessages\s*${DOT}\s*create\s*\(`, 'g'), when: 'mailgun' },
  { id: 'postmark.sendEmail', re: new RegExp(String.raw`${DOT}\s*sendEmail\s*\(`, 'g') },
  {
    id: 'agentisend.emails.send',
    re: new RegExp(String.raw`(?<!resend\s*(?:\.|->)\s*)\bemails\s*${DOT}\s*send\b`, 'g'),
  },
  { id: 'sendgrid.send', re: /\.\s*send\s*\(/g, when: 'sendgrid' },
];

const EMAIL_PARTS = new Set([
  'resend',
  'sendgrid',
  'mailgun',
  'postmark',
  'agentisend',
  'nodemailer',
  'gmail',
  'smtp',
  'ses',
  'amazonses',
]);

const MCP_BASENAMES = new Set(['mcp.json', 'mcp.jsonc', '.mcp.json', 'claude_desktop_config.json']);

export type Scope = 'agent' | 'all';

export type Finding = {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
};

export type ScanOptions = {
  scope?: Scope;
};

type Hit = { start: number; end: number; rule: string };

export function scanRepo(root: string, options: ScanOptions = {}): Finding[] {
  const scope = options.scope ?? 'agent';
  if (scope !== 'agent' && scope !== 'all') {
    throw new Error(`scope must be "agent" or "all", got ${scope}`);
  }
  const info = statSync(root);
  if (!info.isDirectory()) {
    throw new Error(`path must be a directory: ${root}`);
  }

  const files: { rel: string; abs: string }[] = [];
  const policyDirs = new Set<string>();
  walk(root, root, files, policyDirs);

  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...scanFile(file.abs, file.rel, scope, policyDirs));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return findings;
}

function walk(root: string, dir: string, files: { rel: string; abs: string }[], policyDirs: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, abs, files, policyDirs);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toPosix(relative(root, abs));
    if (entry.name === POLICY_FILENAME) {
      const dirName = posix.dirname(rel);
      policyDirs.add(dirName === '.' ? '' : dirName);
      continue;
    }
    const ext = extension(entry.name);
    if (SOURCE_EXT.has(ext) || JSON_EXT.has(ext)) files.push({ rel, abs });
  }
}

function scanFile(abs: string, rel: string, scope: Scope, policyDirs: Set<string>): Finding[] {
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return [];
  }
  if (size > MAX_BYTES) return [];
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\0')) return [];

  if (isMcpConfig(rel, text)) {
    if (policyCovers(rel, policyDirs)) return [];
    return mcpFindings(rel, text);
  }

  const ext = extension(rel);
  if (!SOURCE_EXT.has(ext)) return [];

  const lang = langOf(ext);
  const views = splitCode(text, lang);
  const specs = specifiers(lang, views.code, views.modules);
  const guard = specs.some((s) => s.runtime && isGuardSpecifier(s.spec));
  if (guard) return [];
  if (policyCovers(rel, policyDirs)) return [];

  const agent = specs.some((s) => s.runtime && isAgentSpecifier(s.spec));
  if (scope === 'agent' && !agent) return [];

  const mailgun = mentionsMailgun(specs, views.code);
  const sendgrid = mentionsSendgrid(specs);
  const hits = collectHits(views.code, mailgun, sendgrid);
  return hits.map((hit) => {
    const pos = position(text, hit.start);
    return {
      file: rel,
      line: pos.line,
      column: pos.column,
      rule: hit.rule,
      message: `${hit.rule} is an email send with no agent-email-guard import in this file and no agent-email-guard.json covering it. Add the policy file or import the guard.`,
    };
  });
}

function specifiers(lang: Lang, text: string, modules: CapturedModule[]): Specifier[] {
  if (lang === 'py') return pythonSpecifiers(text);
  if (lang === 'php') return phpSpecifiers(text);
  return modules;
}

function mentionsMailgun(specs: Specifier[], calls: string): boolean {
  if (specs.some((s) => s.runtime && /mailgun/i.test(s.spec))) return true;
  return /\bmailgun\b/i.test(calls);
}

function mentionsSendgrid(specs: Specifier[]): boolean {
  return specs.some((s) => s.runtime && /sendgrid/i.test(s.spec));
}

function collectHits(calls: string, mailgun: boolean, sendgrid: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    if (rule.when === 'mailgun' && !mailgun) continue;
    if (rule.when === 'sendgrid' && !sendgrid) continue;
    for (const match of calls.matchAll(rule.re)) {
      const start = match.index ?? 0;
      hits.push({ start, end: start + match[0].length, rule: rule.id });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  let coveredUntil = -1;
  for (const hit of hits) {
    if (hit.start < coveredUntil) continue;
    kept.push(hit);
    coveredUntil = hit.end;
  }
  return kept;
}

function isMcpConfig(rel: string, text: string): boolean {
  const base = posix.basename(rel);
  if (MCP_BASENAMES.has(base)) return true;
  return text.includes('"mcpServers"') || text.includes('"mcp_servers"');
}

function mcpFindings(rel: string, text: string): Finding[] {
  let parsed: unknown;
  try {
    const masked = splitCode(text, 'js').surface.replace(/,(\s*[}\]])/g, '$1');
    parsed = JSON.parse(masked) as unknown;
  } catch {
    return [];
  }
  const findings: Finding[] = [];
  for (const servers of serverMaps(parsed, MCP_BASENAMES.has(posix.basename(rel)))) {
    for (const [name, config] of Object.entries(servers)) {
      if (!namesEmailServer(name, config)) continue;
      const at = text.indexOf(`"${name}"`);
      const pos = position(text, at < 0 ? 0 : at);
      findings.push({
        file: rel,
        line: pos.line,
        column: pos.column,
        rule: 'mcp.email',
        message: `MCP server "${name}" is an email server and no agent-email-guard.json covers this config. Add the policy file.`,
      });
    }
  }
  return findings;
}

function serverMaps(value: unknown, acceptTopLevelServers: boolean): Record<string, unknown>[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const obj = value as Record<string, unknown>;
  const maps: Record<string, unknown>[] = [];
  for (const key of ['mcpServers', 'mcp_servers']) {
    const child = obj[key];
    if (isRecord(child)) maps.push(child);
  }
  const mcp = obj['mcp'];
  if (isRecord(mcp)) {
    const servers = mcp['servers'];
    if (isRecord(servers)) maps.push(servers);
  }
  if (acceptTopLevelServers && isRecord(obj['servers'])) maps.push(obj['servers']);
  return maps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function namesEmailServer(name: string, config: unknown): boolean {
  if (hasEmailSignal(name, true)) return true;
  for (const field of configFields(config)) {
    if (hasEmailSignal(field, false)) return true;
  }
  return false;
}

function configFields(config: unknown): string[] {
  if (typeof config === 'string') return [config];
  if (Array.isArray(config)) return config.flatMap((item) => configFields(item));
  if (!isRecord(config)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || key === 'headers' || key === 'description') continue;
    out.push(...configFields(value));
  }
  return out;
}

function hasEmailSignal(value: string, allowEmailWord: boolean): boolean {
  const low = value.toLowerCase();
  if (low.includes('send_email') || low.includes('send-email') || low.includes('sendemail')) return true;
  const parts = low.split(/[^a-z0-9]+/).filter((part) => part !== '');
  for (const part of parts) {
    if (EMAIL_PARTS.has(part)) return true;
    if (allowEmailWord && part === 'email') return true;
  }
  return false;
}

function policyCovers(rel: string, policyDirs: Set<string>): boolean {
  let dir = posix.dirname(rel);
  if (dir === '.') dir = '';
  while (true) {
    if (policyDirs.has(dir)) return true;
    if (dir === '') return false;
    const parent = posix.dirname(dir);
    dir = parent === '.' ? '' : parent;
  }
}

function position(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const stop = Math.min(index, source.length);
  for (let i = 0; i < stop; i += 1) {
    if (source.charAt(i) === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function extension(name: string): string {
  const base = posix.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
