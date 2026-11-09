import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-stdio', version: '0.0.0' },
  { capabilities: { tools: {} }, instructions: 'Fake stdio upstream. Sends nothing.' },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'send_email', description: 'Send one email', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'queued' }],
}));
await server.connect(new StdioServerTransport());
