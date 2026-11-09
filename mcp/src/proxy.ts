import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { classifyCall } from './classify.js';
import { decisionLine, toolErrorText } from './log.js';
import { splitCommand } from './split-command.js';
import type { SpecDecision, SpecGuard, SpecSend } from './spec-guard.js';

export const SERVER_NAME = 'agent-email-guard-mcp';
export const SERVER_VERSION = '0.1.0';

export interface UpstreamTarget {
  readonly wrap?: string;
  readonly wrapUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function connectUpstream(target: UpstreamTarget): Promise<Client> {
  if (target.wrap !== undefined && target.wrapUrl !== undefined) {
    throw new Error('Pass --wrap or --wrap-url, not both.');
  }
  if (target.wrap === undefined && target.wrapUrl === undefined) {
    throw new Error('Pass --wrap "<command>" or --wrap-url <https url>.');
  }
  const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: {} });
  if (target.wrapUrl !== undefined) {
    const headers = target.headers ?? {};
    await client.connect(
      new StreamableHTTPClientTransport(new URL(target.wrapUrl), {
        requestInit: { headers: { ...headers } },
      }),
    );
    return client;
  }
  const split = splitCommand(target.wrap ?? '');
  await client.connect(
    new StdioClientTransport({
      command: split.command,
      args: split.args,
      env: definedEnv({ ...process.env, ...target.env }),
      stderr: 'pipe',
    }),
  );
  return client;
}

export interface GuardServerOptions {
  readonly guard: SpecGuard;
  /** null means the name-and-arguments heuristic. */
  readonly sendTools: ReadonlySet<string> | null;
  readonly key?: string;
  readonly log?: (line: string) => void;
}

export function createGuardServer(upstream: Client, options: GuardServerOptions): Server {
  const caps = upstream.getServerCapabilities() ?? {};
  const instructions = upstream.getInstructions();
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        ...(caps.resources ? { resources: {} } : {}),
        ...(caps.prompts ? { prompts: {} } : {}),
      },
      ...(instructions !== undefined ? { instructions } : {}),
    },
  );

  const write = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const keyFor = (): string => options.key ?? upstream.getServerVersion()?.name ?? 'mcp';

  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => upstream.listResources());
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      upstream.readResource({ uri: request.params.uri }),
    );
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => upstream.listPrompts());
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
      upstream.getPrompt({
        name: request.params.name,
        ...(request.params.arguments !== undefined ? { arguments: request.params.arguments } : {}),
      }),
    );
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const classified = classifyCall(name, args, keyFor(), options.sendTools);
    if (classified.kind === 'pass') {
      return upstream.callTool({ name, arguments: args });
    }

    const decided: Array<{ send: SpecSend; decision: SpecDecision }> = [];
    for (const send of classified.messages) {
      const decision = await options.guard.check(send);
      decided.push({ send, decision });
      write(decisionLine(decision, send.key));
      if (decision.outcome !== 'allow') {
        await releaseReserved(options.guard, decided);
        return {
          content: [{ type: 'text', text: toolErrorText(decision) }],
          isError: true,
        };
      }
    }

    try {
      const result = await upstream.callTool({ name, arguments: args });
      if (isToolError(result)) {
        await releaseReserved(options.guard, decided);
        return result;
      }
      await recordReserved(options.guard, decided);
      return result;
    } catch (err) {
      await releaseReserved(options.guard, decided);
      throw err;
    }
  });

  return server;
}

function isToolError(result: unknown): boolean {
  return result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
}

async function releaseReserved(
  guard: SpecGuard,
  decided: readonly { decision: SpecDecision }[],
): Promise<void> {
  for (const row of decided) {
    if (row.decision.outcome === 'allow' && row.decision.reservationId) {
      await guard.release(row.decision.reservationId);
    }
  }
}

async function recordReserved(
  guard: SpecGuard,
  decided: readonly { decision: SpecDecision }[],
): Promise<void> {
  for (const row of decided) {
    if (row.decision.reservationId) await guard.record(row.decision.reservationId);
  }
}
