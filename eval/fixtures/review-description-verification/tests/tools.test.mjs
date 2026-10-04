import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/tools.mjs';

async function withClient(project, verify) {
  const server = createServer(project);
  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await verify(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

async function callEnqueue(client, args) {
  const result = await client.callTool({ name: 'enqueue', arguments: args });
  return JSON.parse(result.content[0].text);
}

test('explicit draft true and false override the project setting through MCP', async () => {
  for (const value of [true, false]) {
    await withClient({ draft: !value }, async (client) => {
      assert.equal((await callEnqueue(client, { title: 'task', draft: value })).draft, value);
    });
  }
});

test('omitted draft inherits the project setting through MCP', async () => {
  for (const value of [true, false]) {
    await withClient({ draft: value }, async (client) => {
      assert.equal((await callEnqueue(client, { title: 'task' })).draft, value);
    });
  }
});

test('MCP client receives the new optional boolean input', async () => {
  await withClient({ draft: false }, async (client) => {
    const { tools: [tool] } = await client.listTools();
    assert.equal(tool.name, 'enqueue');
    assert.equal(tool.inputSchema.properties.draft.type, 'boolean');
    assert.deepEqual(tool.inputSchema.required, ['title']);
  });
});
