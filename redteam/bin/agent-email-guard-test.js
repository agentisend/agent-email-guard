#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// Resolve tsx from this package, not from the caller's directory, so `npx agent-email-guard test` works anywhere.
const tsx = import.meta.resolve('tsx');
const child = spawnSync(process.execPath, ['--import', tsx, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
