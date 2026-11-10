/**
 * The proxy's contract: an allowed request is forwarded as the bytes that
 * arrived, the 21st send against per_day 20 is refused, an upstream error
 * gives the reservation back, and the Authorization header and the body are
 * never written to a log.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startProxy, type RunningProxy } from '../src/proxy.js';

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Stub {
  url: string;
  requests: Captured[];
  status: number;
  responseBody: string;
  close: () => Promise<void>;
}

const running: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

function listen(server: ReturnType<typeof createServer>, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    url: '',
    requests: [],
    status: 200,
    responseBody: '{"id":"email_1"}',
    close: async () => undefined,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      stub.requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const body = Buffer.from(stub.responseBody);
      res.statusCode = stub.status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', String(body.length));
      res.end(body);
    });
  });
  const port = await listen(server);
  stub.url = `http://127.0.0.1:${port}`;
  stub.close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  running.push(stub);
  return stub;
}

function writePolicy(dir: string, policy: unknown): { policyPath: string; storePath: string } {
  const policyPath = join(dir, 'agent-email-guard.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  return { policyPath, storePath: join(dir, 'store.json') };
}

async function boot(upstream: string, policy: unknown, storePath?: string): Promise<RunningProxy> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-proxy-'));
  const files = writePolicy(dir, policy);
  const proxy = await startProxy({
    upstream,
    policyPath: files.policyPath,
    storePath: storePath ?? files.storePath,
    host: '127.0.0.1',
    port: 0,
  });
  running.push(proxy);
  return proxy;
}

function call(proxyUrl: string, path: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  const target = new URL(path, proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('allowed requests are forwarded byte-identical', () => {
  it('POST /emails keeps the body bytes and the Authorization value', async () => {
    const stub = await startStub();
    const proxy = await boot(stub.url, { version: 1, budgets: { per_day: 20 }, loop: { mode: 'off' } });
    const raw = Buffer.from('{"to":["ada@example.com"],"subject":"Hello","text":"keep  spaces\\n"}');
    const response = await call(proxy.url, '/emails', raw, { authorization: 'Bearer re_live_example' });
    expect(response.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
    const forwarded = stub.requests[0]!;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe('/emails');
    expect(Buffer.compare(forwarded.body, raw)).toBe(0);
    expect(forwarded.headers.authorization).toBe('Bearer re_live_example');
  });

  it('POST /emails/batch is forwarded whole when every message is allowed', async () => {
    const stub = await startStub();
    const proxy = await boot(stub.url, { version: 1, budgets: { per_day: 20 }, loop: { mode: 'off' } });
    const raw = Buffer.from(
      '[{"to":["ada@example.com"],"subject":"One","text":"a"},{"to":["bea@example.com"],"subject":"Two","text":"b  "}]',
    );
    const response = await call(proxy.url, '/emails/batch', raw);
    expect(response.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
    expect(Buffer.compare(stub.requests[0]!.body, raw)).toBe(0);
    expect(stub.requests[0]!.url).toBe('/emails/batch');
  });
});

describe('the 21st send with per_day 20 is refused', () => {
  it('refuses from the file store after a restart, and does not call upstream', async () => {
    const stub = await startStub();
    const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-proxy-'));
    const files = writePolicy(dir, { version: 1, budgets: { per_day: 20 }, loop: { mode: 'off' } });
    const first = await startProxy({
      upstream: stub.url,
      policyPath: files.policyPath,
      storePath: files.storePath,
      host: '127.0.0.1',
      port: 0,
    });
    running.push(first);
    for (let i = 1; i <= 20; i += 1) {
      const body = Buffer.from(
        JSON.stringify({
          from: 'Acme <hello@acme.example>',
          to: [`user${i}@example.com`],
          subject: `Receipt ${i}`,
          text: `Amount ${i} for order ${i * 17}.`,
        }),
      );
      const response = await call(first.url, '/emails', body);
      expect(response.status, `send ${i}`).toBe(200);
    }
    await first.close();
    running.pop();

    const second = await startProxy({
      upstream: stub.url,
      policyPath: files.policyPath,
      storePath: files.storePath,
      host: '127.0.0.1',
      port: 0,
    });
    running.push(second);
    const refused = await call(
      second.url,
      '/emails',
      Buffer.from(JSON.stringify({ to: ['user21@example.com'], subject: 'Receipt 21', text: 'Amount 21.' })),
    );
    expect(stub.requests).toHaveLength(20);
    expect(refused.status).toBe(429);
    const error = JSON.parse(refused.body.toString('utf8')) as { name: string; message: string; statusCode: number };
    expect(error.name).toBe('agent_budget_exceeded');
    expect(error.statusCode).toBe(429);
    expect(error.message).toContain('daily budget');
  });

  it('refuses a batch that would pass the cap and forwards nothing', async () => {
    const stub = await startStub();
    const proxy = await boot(stub.url, { version: 1, budgets: { per_day: 1 }, loop: { mode: 'off' } });
    const raw = Buffer.from(
      '[{"to":["ada@example.com"],"subject":"One","text":"a"},{"to":["bea@example.com"],"subject":"Two","text":"b"}]',
    );
    const refused = await call(proxy.url, '/emails/batch', raw);
    expect(refused.status).toBe(429);
    expect(stub.requests).toHaveLength(0);
    const again = await call(
      proxy.url,
      '/emails',
      Buffer.from('{"to":["cy@example.com"],"subject":"Still within the cap","text":"one"}'),
    );
    expect(again.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
  });
});

describe('an upstream error releases the reservation', () => {
  it('counts a later success and refuses the one after that', async () => {
    const stub = await startStub();
    stub.status = 500;
    stub.responseBody = '{"name":"application_error","message":"nope"}';
    const proxy = await boot(stub.url, { version: 1, budgets: { per_day: 1 }, loop: { mode: 'off' } });
    const body = Buffer.from('{"to":["ada@example.com"],"subject":"Hello","text":"once"}');
    const failed = await call(proxy.url, '/emails', body);
    expect(failed.status).toBe(500);
    expect(failed.body.toString('utf8')).toBe(stub.responseBody);

    stub.status = 200;
    stub.responseBody = '{"id":"email_ok"}';
    const sent = await call(proxy.url, '/emails', body);
    expect(sent.status).toBe(200);
    expect(sent.body.toString('utf8')).toBe('{"id":"email_ok"}');

    const refused = await call(proxy.url, '/emails', body);
    expect(refused.status).toBe(429);
    const error = JSON.parse(refused.body.toString('utf8')) as { name: string; statusCode: number };
    expect(error.name).toBe('agent_budget_exceeded');
    expect(error.statusCode).toBe(429);
    expect(stub.requests).toHaveLength(2);
  });
});

describe('headers and bodies are never logged', () => {
  it('does not write the Authorization value or the message body', async () => {
    const stub = await startStub();
    const proxy = await boot(stub.url, { version: 1, budgets: { per_day: 5 }, loop: { mode: 'off' } });
    const token = 'Bearer HEADERMARKER-secret-token';
    const raw = Buffer.from('{"to":["ada@example.com"],"subject":"Hello","text":"BODYMARKER-secret-phrase"}');
    const chunks: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    const stdout = process.stdout.write.bind(process.stdout);
    const push = (chunk: unknown): void => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    };
    process.stderr.write = ((chunk: unknown) => {
      push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const response = await call(proxy.url, '/emails', raw, { authorization: token });
      expect(response.status).toBe(200);
    } finally {
      process.stderr.write = stderr;
      process.stdout.write = stdout;
    }
    const logged = chunks.join('\n');
    expect(stub.requests[0]!.headers.authorization).toBe(token);
    expect(logged).not.toContain('HEADERMARKER-secret-token');
    expect(logged).not.toContain('BODYMARKER-secret-phrase');
    expect(logged).not.toContain('authorization');
    expect(logged).toContain('"outcome":"forward"');
  });
});

describe('a hold is a 403 and is not forwarded', () => {
  it('returns the guard reason and does not call upstream', async () => {
    const stub = await startStub();
    const proxy = await boot(stub.url, {
      version: 1,
      loop: { mode: 'off' },
      approval: { recipients: ['ada@example.com'] },
    });
    const response = await call(
      proxy.url,
      '/emails',
      Buffer.from('{"to":["ada@example.com"],"subject":"Hello","text":"wait"}'),
    );
    expect(response.status).toBe(403);
    const error = JSON.parse(response.body.toString('utf8')) as { name: string; message: string; statusCode: number };
    expect(error.name).toBe('recipient_requires_approval');
    expect(error.statusCode).toBe(403);
    expect(error.message.length).toBeGreaterThan(8);
    expect(stub.requests).toHaveLength(0);
  });
});
