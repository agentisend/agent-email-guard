#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const child = spawnSync(process.execPath, ['--import', 'tsx', cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
