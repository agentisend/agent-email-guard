#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, parseArgs } from './config.js';
import { evaluateHook, hookStatus, installHook, settingsFile, uninstallHook } from './hook.js';
import { connectUpstream, createGuardServer } from './proxy.js';
import { openGuard, sendToolSet } from './runtime.js';

export const USAGE = `agent-email-guard-mcp — blast-radius control for agents that send email.

  agent-email-guard-mcp hook install          Claude Code PreToolUse hook (project)
  agent-email-guard-mcp hook install --user   same hook, under your user settings
  agent-email-guard-mcp hook uninstall [--user]
  agent-email-guard-mcp hook status [--user]
  agent-email-guard-mcp --wrap "<command>"
  agent-email-guard-mcp --wrap-url <https url> --header "Name: value"
  agent-email-guard-mcp pause | resume | approvals | approve <id>

The published library's bin is agent-email-guard. It forwards hook and mcp
to this package. This package does not install that bin.

The proxy speaks MCP on stdin/stdout. Decisions are JSON lines on stderr.
Recipients in those lines are hashes. Message bodies are not logged.

The hook reads agent-email-guard.json (the library's policy loader) and a
file store. On a refusal or a hold it prints a PreToolUse deny and exits 0.
On an allow it records the send and prints allow. A tool that is not a send
prints nothing. The installed command is \`npx --yes agent-email-guard-mcp@0.2 hook run\`,
which uses the copy already on disk and does not store an npx cache path.

Flags override the policy file. The policy file uses the library's keys
(budgets.per_day, rate.per_minute, loop.mode). There is no daily ceiling
until the policy or --per-day sets one. Loop mode defaults to the library:
full, and the 4th near-identical send in the window is refused.
  --send-tools send_email,send_batch
  --per-day N   --per-hour N   --per-minute N
  --loop full|repetition_only|off
  --key <name>                         default: the upstream server name
  --store memory|file                  default memory (the hook always uses a file)
  --store-path --control --approvals  default under ./.agent-email-guard/
  --config <file>
`;

export async function run(
  argv: readonly string[] = process.argv.slice(2),
  io: { stdout?: (line: string) => void; stderr?: (line: string) => void; cwd?: string } = {},
): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = io.stderr ?? ((line: string) => process.stderr.write(line));
  const cwd = io.cwd ?? process.cwd();
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(USAGE);
    return 0;
  }

  let config;
  try {
    config = loadConfig(flags, cwd);
  } catch (err) {
    stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const opened = openGuard(config);
  if (flags.command === 'pause' || flags.command === 'resume') {
    if (flags.command === 'pause') {
      await opened.guard.killSwitch.pause('paused from the command line', 'agent-email-guard-mcp');
      stdout('paused\n');
    } else {
      const resumed = await opened.guard.killSwitch.resume('agent-email-guard-mcp');
      stdout(resumed ? 'resumed\n' : 'not paused\n');
    }
    return 0;
  }

  const approvals = opened.approvals;
  if (flags.command === 'approvals') {
    const rows = await approvals.list();
    if (rows.length === 0) {
      stdout('No sends are waiting.\n');
      return 0;
    }
    for (const row of rows) {
      const hashes = row.recipientHashes.map((hash) => hash.slice(0, 12)).join(',');
      stdout(`${row.id}  recipients=${hashes}  since ${row.createdAt}\n`);
    }
    return 0;
  }
  if (flags.command === 'approve') {
    const id = flags.approveId ?? '';
    const ok = await approvals.approve(id);
    if (!ok) {
      stderr(`No held send has id ${id}. Run agent-email-guard-mcp approvals.\n`);
      return 1;
    }
    stdout(`approved ${id}\n`);
    return 0;
  }

  if (flags.command === 'hook') {
    const action = flags.hookAction ?? 'status';
    if (action === 'run') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const result = await evaluateHook(Buffer.concat(chunks).toString('utf8'), cwd);
      if (result.stdout.length > 0) stdout(result.stdout);
      if (result.stderr.length > 0) stderr(result.stderr);
      return result.exitCode;
    }
    const path = settingsFile(flags.userScope, cwd);
    if (action === 'install') {
      installHook(path);
      stdout(`installed ${path}\n`);
      return 0;
    }
    if (action === 'uninstall') {
      const removed = uninstallHook(path);
      stdout(removed ? `removed ${path}\n` : `no hook in ${path}\n`);
      return 0;
    }
    const status = hookStatus(path);
    stdout(
      status.installed
        ? `installed ${status.path}\nmatcher ${status.matcher ?? ''}\n`
        : `not installed ${status.path}\n`,
    );
    return 0;
  }

  try {
    const upstream = await connectUpstream({
      ...(config.wrap !== undefined ? { wrap: config.wrap } : {}),
      ...(config.wrapUrl !== undefined ? { wrapUrl: config.wrapUrl } : {}),
      headers: config.headers,
    });
    const server = createGuardServer(upstream, {
      guard: opened,
      sendTools: sendToolSet(config),
      ...(config.key !== undefined ? { key: config.key } : {}),
    });
    await server.connect(new StdioServerTransport());
    return 0;
  } catch (err) {
    stderr(`${(err as Error).message}\n`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (invokedDirectly()) {
  run()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
