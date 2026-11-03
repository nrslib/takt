import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [logPath, serverName] = process.argv.slice(2);
const toolNames = serverName === 'backlog' ? ['get_issue', 'add_issue'] : ['takt_enqueue_goal_task'];
const server = new Server({ name: serverName, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolNames.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!toolNames.includes(request.params.name)) throw new Error('Unknown fixture tool');
  const invocation = { server: serverName, tool: request.params.name, arguments: request.params.arguments };
  appendFileSync(logPath, `${JSON.stringify(invocation)}\n`);
  return { content: [{ type: 'text', text: JSON.stringify(invocation) }] };
});
await server.connect(new StdioServerTransport());
