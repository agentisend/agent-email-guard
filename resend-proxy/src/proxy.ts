/**
 * Local HTTP proxy. POST /emails and POST /emails/batch are checked, one
 * message at a time, against agent-email-guard. An allow is forwarded as the
 * bytes that arrived. A refuse or a hold is a Resend-shaped error and is not
 * forwarded. Any other path is forwarded without a check.
 *
 * The Authorization header is copied through. Logs are method, path, outcome,
 * reason token and status. They do not carry headers or bodies.
 */

import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGuard, type Decision, type Guard, type GuardSend } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';
import { FileStore } from './file-store.js';
import { messagesFrom, RequestShapeError } from './messages.js';

export const DEFAULT_UPSTREAM = 'https://api.resend.com';
export const DEFAULT_PORT = 8787;
const MAX_BODY = 48 * 1024 * 1024;

const SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
]);

export interface ProxyLogEntry {
  method: string;
  path: string;
  outcome: 'forward' | 'refuse' | 'hold' | 'upstream_error' | 'invalid';
  reason?: string;
  status: number;
}

export interface StartProxyOptions {
  /** Base URL allowed requests are forwarded to. Default https://api.resend.com. */
  upstream?: string;
  /** agent-email-guard.json. Default: that name in the working directory. */
  policyPath?: string;
  /** File store path. Default: .agent-email-guard/store.json */
  storePath?: string;
  host?: string;
  port?: number;
  log?: (entry: ProxyLogEntry) => void;
}

export interface RunningProxy {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface UpstreamResult {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function defaultLog(entry: ProxyLogEntry): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function pathnameOf(url: string): string {
  const path = url.split('?')[0] ?? '/';
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function statusFor(decision: Decision): number {
  if (decision.outcome === 'hold_for_approval') return 403;
  if (decision.reason === 'agent_budget_exceeded' || decision.reason === 'rate_ceiling_exceeded') return 429;
  return 403;
}

function writeJson(res: ServerResponse, status: number, name: string, message: string): void {
  const body = Buffer.from(JSON.stringify({ name, message, statusCode: status }));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('too_large');
        (err as NodeJS.ErrnoException).code = 'too_large';
        req.destroy();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

function outgoingHeaders(headers: IncomingHttpHeaders, host: string, bodyLength: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || SKIP_HEADERS.has(name)) continue;
    out[name] = value;
  }
  out.host = host;
  out['content-length'] = String(bodyLength);
  return out;
}

function forward(upstream: URL, req: IncomingMessage, body: Buffer): Promise<UpstreamResult> {
  const target = new URL(req.url ?? '/', upstream);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = outgoingHeaders(req.headers, target.host, body.length);
  return new Promise((resolve, reject) => {
    const request = transport(
      {
        hostname: target.hostname,
        port: target.port === '' ? undefined : target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') request.write(body);
    request.end();
  });
}

function writeUpstream(res: ServerResponse, upstream: UpstreamResult): void {
  res.statusCode = upstream.statusCode;
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || SKIP_HEADERS.has(name)) continue;
    res.setHeader(name, value);
  }
  res.setHeader('content-length', String(upstream.body.length));
  res.end(upstream.body);
}

async function releaseAll(guard: Guard, decisions: readonly Decision[]): Promise<void> {
  for (const decision of decisions) await guard.release(decision);
}

export async function startProxy(options: StartProxyOptions = {}): Promise<RunningProxy> {
  const upstream = new URL(options.upstream ?? DEFAULT_UPSTREAM);
  const config = loadPolicy(options.policyPath);
  const store = new FileStore(options.storePath ?? '.agent-email-guard/store.json');
  const guard = createGuard({ ...config, store });
  const log = options.log ?? defaultLog;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeJson(res, 500, 'application_error', 'The proxy failed before a decision.');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const path = pathnameOf(url);
    const emit = (entry: Omit<ProxyLogEntry, 'method' | 'path'>): void => {
      log({ method, path, ...entry });
    };

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      const tooLarge = (err as NodeJS.ErrnoException).code === 'too_large';
      const status = tooLarge ? 413 : 400;
      const name = tooLarge ? 'payload_too_large' : 'validation_error';
      const message = tooLarge ? 'The request body is too large.' : 'The request body could not be read.';
      writeJson(res, status, name, message);
      emit({ outcome: 'invalid', status });
      return;
    }

    const kind = method === 'POST' && path === '/emails' ? 'single' : method === 'POST' && path === '/emails/batch' ? 'batch' : null;
    let messages: GuardSend[] = [];
    if (kind) {
      try {
        messages = messagesFrom(kind, body);
      } catch (err) {
        const message = err instanceof RequestShapeError ? err.message : 'The body is not a valid email request.';
        writeJson(res, 422, 'validation_error', message);
        emit({ outcome: 'invalid', reason: 'validation_error', status: 422 });
        return;
      }
    }

    const decisions: Decision[] = [];
    for (const send of messages) {
      const decision = await guard.check(send);
      if (decision.outcome !== 'allow') {
        await releaseAll(guard, decisions);
        const status = statusFor(decision);
        writeJson(res, status, decision.reason, decision.message);
        emit({
          outcome: decision.outcome === 'hold_for_approval' ? 'hold' : 'refuse',
          reason: decision.reason,
          status,
        });
        return;
      }
      decisions.push(decision);
    }

    let upstreamResult: UpstreamResult;
    try {
      upstreamResult = await forward(upstream, req, body);
    } catch {
      await releaseAll(guard, decisions);
      writeJson(res, 502, 'application_error', 'The upstream request failed.');
      emit({ outcome: 'upstream_error', status: 502 });
      return;
    }

    if (upstreamResult.statusCode >= 400) {
      await releaseAll(guard, decisions);
      emit({ outcome: 'upstream_error', status: upstreamResult.statusCode });
    } else {
      for (const send of messages) await guard.record(send);
      emit({ outcome: 'forward', status: upstreamResult.statusCode });
    }
    writeUpstream(res, upstreamResult);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The proxy did not bind a port.');
  const bound = address.port;
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
