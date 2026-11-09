import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The kill switch is a local file so `agent-email-guard pause` and the
 * running proxy share one bit. A missing file means sending is allowed.
 * A file that exists but cannot be parsed fails closed.
 */
export function readPaused(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
  try {
    const data = JSON.parse(text) as { paused?: unknown };
    return data.paused === true;
  } catch {
    return true;
  }
}

export function writePaused(path: string, paused: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ paused, at: new Date().toISOString() }));
  renameSync(tmp, path);
}
