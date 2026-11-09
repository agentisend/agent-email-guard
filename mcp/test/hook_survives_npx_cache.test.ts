import { describe, expect, it } from 'vitest';
import { hookHandler, isOurHook, NPX_PACKAGE_SPEC } from '../src/hook.js';

describe('hook install from npx', () => {
  it('points the hook at the package, not at the npx cache path', () => {
    const h = hookHandler('/Users/me/.npm/_npx/0a1b2c/node_modules/agent-email-guard-mcp/dist/cli.js');
    expect(h.command).toBe('npx');
    expect(h.args).toEqual(['--yes', NPX_PACKAGE_SPEC, 'hook', 'run']);
    expect(h.onFailure).toBe('block');
    expect(isOurHook(h)).toBe(true);
  });

  it('keeps the exec form for a global or local install', () => {
    const h = hookHandler('/usr/local/lib/node_modules/agent-email-guard-mcp/dist/cli.js');
    expect(h.command).toBe(process.execPath);
    expect(h.args.at(-2)).toBe('hook');
    expect(isOurHook(h)).toBe(true);
  });
});
