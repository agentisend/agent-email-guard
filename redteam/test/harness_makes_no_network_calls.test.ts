import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { runAgent as naive } from '../examples/naive-agent.js';
import { runAgent as aiSdk } from '../examples/ai-sdk-agent.js';
import { createReferenceGuard } from '../src/guard-adapter.js';
import { runHarness } from '../src/harness.js';
import { readPolicyFile } from '../src/policy.js';
import { loadScenarios, packageRoot } from '../src/scenarios.js';
import { join } from 'node:path';

describe('no network', () => {
  it('the naive run does not call fetch, dns, or a socket', async () => {
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls.push('fetch');
      throw new Error('fetch');
    });
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((...args: unknown[]) => {
      calls.push('dns.lookup');
      const callback = args.at(-1);
      if (typeof callback === 'function') (callback as (error: Error) => void)(new Error('dns'));
    }) as typeof dns.lookup);
    const httpRequest = vi.spyOn(http, 'request').mockImplementation(() => {
      calls.push('http.request');
      throw new Error('http');
    });
    const httpsRequest = vi.spyOn(https, 'request').mockImplementation(() => {
      calls.push('https.request');
      throw new Error('https');
    });
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function mockConnect(this: net.Socket) {
      calls.push('socket.connect');
      return this;
    });

    const root = packageRoot();
    const { benchmark, scenarios } = loadScenarios(root);
    const policy = readPolicyFile(join(root, 'defaults', 'agent-email-guard.json'));
    const report = await runHarness({
      runAgent: naive,
      scenarios,
      createGuard: () => createReferenceGuard(policy),
      guardSource: 'reference',
      policyPath: 'defaults/agent-email-guard.json',
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
    });

    fetchSpy.mockRestore();
    lookup.mockRestore();
    httpRequest.mockRestore();
    httpsRequest.mockRestore();
    connect.mockRestore();

    expect(report.pass).toBe(true);
    expect(calls).toEqual([]);
  });

  it('the model example skips, and does not import a provider, when no key is set', async () => {
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls.push('fetch');
      throw new Error('fetch');
    });
    await expect(
      aiSdk(
        {
          id: 'x',
          name: 'x',
          task: 'Send nothing.',
          untrusted: { channel: 'none', content: '' },
          fixtures: { contacts: [] },
          script: [],
        },
        {
          email: { send: () => Promise.reject(new Error('send should not be called')) },
          contacts: { list: () => Promise.resolve([]) },
          limits: { raise: () => Promise.reject(new Error('limits should not be called')) },
        },
      ),
    ).rejects.toMatchObject({ name: 'SKIP_NO_MODEL' });
    fetchSpy.mockRestore();
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    expect(calls).toEqual([]);
  });
});
