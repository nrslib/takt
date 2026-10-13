import { existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'mock-abort-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
if (process.argv[4] === 'initialize') {
  server.setRequestHandler(InitializeRequestSchema, async (request, { signal }) => {
    writeFileSync(process.argv[3], 'initialization started');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-abort-fixture', version: '1.0.0' },
    };
  });
}
if (process.argv[4] === 'cleanup') {
  process.stdin.on('end', () => {
    writeFileSync(process.argv[3], 'cleanup started');
    const timer = setInterval(() => {
      if (existsSync(process.argv[5])) clearInterval(timer);
    }, 10);
  });
}
server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
  if (request.params.name === 'enqueue') {
    writeFileSync(process.argv[2], 'enqueued');
    return { content: [{ type: 'text', text: 'task enqueued' }] };
  }
  writeFileSync(process.argv[3], 'call started');
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  return { content: [] };
});
await server.connect(new StdioServerTransport());
