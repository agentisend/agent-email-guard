import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createGuardServer } from '../src/proxy.js';
import { openGuard, type OpenedGuard } from '../src/runtime.js';

export interface FakeCounts {
  sendEmail: number;
  sendBatch: number;
  listLabels: number;
  failSendEmail: number;
}

export function textOf(result: unknown): string {
  if (result === null || typeof result !== 'object' || !('content' in result)) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (item !== null && typeof item === 'object' && 'text' in item) return String((item as { text: unknown }).text);
      return '';
    })
    .join('\n');
}

export async function startFake(counts: FakeCounts): Promise<Server> {
  const server = new Server(
    { name: 'fake-email', version: '0.0.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: 'Fake upstream. Sends nothing.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'send_email', description: 'Send one email', inputSchema: { type: 'object' } },
      { name: 'send_batch', description: 'Send many emails', inputSchema: { type: 'object' } },
      { name: 'list_labels', description: 'List labels', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'fake://labels', name: 'labels' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, text: 'labels' }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'draft', description: 'Draft' }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'draft' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'list_labels') {
      counts.listLabels += 1;
      return { content: [{ type: 'text', text: 'inbox' }] };
    }
    if (request.params.name === 'send_batch') {
      counts.sendBatch += 1;
      return { content: [{ type: 'text', text: 'batch-queued' }] };
    }
    counts.sendEmail += 1;
    if (counts.failSendEmail > 0) {
      counts.failSendEmail -= 1;
      return { content: [{ type: 'text', text: 'upstream failed' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'queued' }] };
  });
  return server;
}

export interface GuardFiles {
  dir: string;
  control: string;
  approvals: string;
  store: string;
}

export function tempGuardFiles(): GuardFiles {
  const dir = mkdtempSync(join(tmpdir(), 'agent-email-guard-'));
  return {
    dir,
    control: join(dir, 'control.json'),
    approvals: join(dir, 'approvals.json'),
    store: join(dir, 'store.json'),
  };
}

export function guardFor(
  files: GuardFiles,
  limits: { perDay: number; perHour?: number; loopMode?: 'off' | 'full'; approvalRecipients?: string[] },
  ledger: 'memory' | 'file' = 'memory',
): OpenedGuard {
  return openGuard({
    guard: {
      budgets: {
        perDay: limits.perDay,
        ...(limits.perHour !== undefined ? { perHour: limits.perHour } : {}),
      },
      loop: { mode: limits.loopMode ?? 'full' },
      ...(limits.approvalRecipients !== undefined && limits.approvalRecipients.length > 0
        ? { approval: { recipients: limits.approvalRecipients } }
        : {}),
    },
    store: ledger,
    storePath: files.store,
    controlFile: files.control,
    approvalsFile: files.approvals,
    sendTools: null,
    headers: {},
  });
}

export async function connectHost(upstream: Server, guard: OpenedGuard): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const upstreamClient = new Client({ name: 'agent-email-guard-mcp', version: '0.2.0' }, { capabilities: {} });
  const [upstreamClientSide, upstreamServerSide] = InMemoryTransport.createLinkedPair();
  await upstream.connect(upstreamServerSide);
  await upstreamClient.connect(upstreamClientSide);
  const proxy = createGuardServer(upstreamClient, { guard, sendTools: null, key: 'test-key', log: () => undefined });
  const host = new Client({ name: 'host', version: '1' }, { capabilities: {} });
  const [hostSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(proxySide);
  await host.connect(hostSide);
  return {
    client: host,
    close: async () => {
      await host.close();
      await proxy.close();
      await upstreamClient.close();
      await upstream.close();
    },
  };
}
