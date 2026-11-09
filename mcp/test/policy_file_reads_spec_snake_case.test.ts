import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../src/config.js';

function dirWith(policy: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aeg-'));
  writeFileSync(join(dir, 'agent-email-guard.json'), JSON.stringify(policy));
  return dir;
}

describe('agent-email-guard.json', () => {
  it('reads the spec snake_case keys (one file for every language)', () => {
    const c = loadConfig(parseArgs([]), dirWith({ version: 1, budgets: { per_day: 2, per_hour: 1 }, rate: { per_minute: 3 } }));
    expect(c.perDay).toBe(2);
    expect(c.perHour).toBe(1);
    expect(c.perMinute).toBe(3);
  });

  it('still reads the 0.1.0 camelCase keys', () => {
    const c = loadConfig(parseArgs([]), dirWith({ budgets: { perDay: 4 } }));
    expect(c.perDay).toBe(4);
  });
});
