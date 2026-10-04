import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function enqueue(args, project) {
  return { title: args.title, draft: args.draft === undefined ? project.draft : args.draft };
}

export function createServer(project) {
  const server = new Server({ name: 'draft-task-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'enqueue') throw new Error('Unknown tool');
    return { content: [{ type: 'text', text: JSON.stringify(enqueue(request.params.arguments, project)) }] };
  });
  return server;
}

export function listTools() {
  return [{
    name: 'enqueue',
    description: 'Enqueue a task. Explicit draft true or false takes precedence over the project setting; when omitted, draft inherits that setting.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, draft: { type: 'boolean' } },
      required: ['title'],
    },
  }];
}
