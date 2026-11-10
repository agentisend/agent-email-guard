#!/usr/bin/env node
import { DEFAULT_PORT, DEFAULT_UPSTREAM, startProxy } from './proxy.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

const portText = flag('--port') ?? process.env.PORT ?? process.env.AGENT_EMAIL_GUARD_PORT ?? String(DEFAULT_PORT);
const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Port ${portText} is not a TCP port.`);
}

const proxy = await startProxy({
  port,
  host: flag('--host') ?? '127.0.0.1',
  upstream: flag('--upstream') ?? process.env.AGENT_EMAIL_GUARD_UPSTREAM ?? DEFAULT_UPSTREAM,
  ...(flag('--policy') !== undefined || process.env.AGENT_EMAIL_GUARD_POLICY !== undefined
    ? { policyPath: flag('--policy') ?? process.env.AGENT_EMAIL_GUARD_POLICY }
    : {}),
  ...(flag('--store') !== undefined || process.env.AGENT_EMAIL_GUARD_STORE !== undefined
    ? { storePath: flag('--store') ?? process.env.AGENT_EMAIL_GUARD_STORE }
    : {}),
});

process.stderr.write(`agent-email-guard-proxy listening on ${proxy.url}\n`);
