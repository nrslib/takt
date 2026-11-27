import { ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CancelledNotificationSchema, isJSONRPCRequest, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { afterEach, expect, it, vi } from 'vitest';
import { startLocalMcpConnection } from '../features/mcp/localConnection.js';
import { deferred } from './helpers/daemon-turn.js';
import { acquireRepositoryAssignmentLocks } from '../infra/conversations/assignmentLock.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';

vi.mock('../infra/daemon/process.js', async (original) => ({
  ...await original<typeof import('../infra/daemon/process.js')>(),
  readProcessOwner: async (pid: number) => ({ pid, startTime: 'test-process-start' }),
}));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });

async function batchConnection(connection: Awaited<ReturnType<typeof startLocalMcpConnection>>) {
  const client = new Client({ name: 'batch-resources', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), {
    requestInit: { headers: connection.config.headers },
    fetch: (url, options) => {
      if (typeof options?.body === 'string') {
        const message = JSON.parse(options.body);
        if (message.method === 'initialize') return fetch(url, { ...options,
          body: JSON.stringify({ ...message, params: { ...message.params, protocolVersion: '2025-03-26' } }) });
      }
      return fetch(url, options);
    },
  });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const post = (body: unknown, signal: AbortSignal = AbortSignal.timeout(5000)) => fetch(connection.config.url, { method: 'POST', headers: {
    ...connection.config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': transport.sessionId!, 'MCP-Protocol-Version': transport.protocolVersion!,
  }, body: JSON.stringify(body), signal });
  return { client, post };
}
const holdRequest = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'hold', arguments: { index: id } } });

it('collects one validated HTTP batch at the public transport dispatch boundary before starting handlers', async () => {
  const events: unknown[] = [];
  const connect = McpServer.prototype.connect;
  vi.spyOn(McpServer.prototype, 'connect').mockImplementation(async function(this: McpServer, transport) {
    await connect.call(this, transport);
    const forward = transport.onmessage!;
    let pending: Array<Parameters<NonNullable<typeof transport.onmessage>>> = [];
    transport.onmessage = (message, extra) => {
      if (!isJSONRPCRequest(message) || message.method !== 'tools/call') { forward(message, extra); return; }
      pending.push([message, extra]);
      if (pending.length === 1) queueMicrotask(() => {
        const messages = pending; pending = [];
        events.push({ collected: messages.map(([value]) => isJSONRPCRequest(value) ? value.id : null) });
        for (const [value, info] of messages) forward(value, info);
      });
    };
  });
  const connection = await startLocalMcpConnection(() => {
    const server = new McpServer({ name: 'dispatch-probe', version: '1' });
    server.registerTool('hold', { inputSchema: z.object({ index: z.number() }) }, async ({ index }) => {
      events.push({ handler: index }); return { content: [{ type: 'text', text: String(index) }] };
    }); return server;
  });
  cleanups.push(connection.dispose);
  const { post } = await batchConnection(connection);
  const wire = await (await post([holdRequest(1), holdRequest(2)])).json();
  console.log(JSON.stringify({ publicBatchDispatchProbe: events, wire }));
  expect(events).toEqual([{ collected: [1, 2] }, { handler: 1 }, { handler: 2 }]);
  expect(wire).toHaveLength(2);
});

it('uses a public cancellation handler to return a cancelled tool result while delivering the other batch result', async () => {
  const controllers = new Map<RequestId, AbortController>();
  const ready = deferred<void>(); const cancelled = deferred<void>(); const finish = deferred<void>();
  const connection = await startLocalMcpConnection(() => {
    const server = new McpServer({ name: 'cancellation-probe', version: '1' });
    server.server.setNotificationHandler(CancelledNotificationSchema, (notice) => {
      if (notice.params.requestId !== undefined) controllers.get(notice.params.requestId)?.abort();
    });
    server.registerTool('hold', { inputSchema: z.object({ index: z.number() }) }, async (_value, extra) => {
      const controller = new AbortController(); controllers.set(extra.requestId, controller);
      controller.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      if (controllers.size === 2) ready.resolve();
      await finish.promise;
      return { ...(controller.signal.aborted ? { isError: true } : {}), content: [{ type: 'text', text: controller.signal.aborted ? 'Request cancelled' : 'done' }] };
    }); return server;
  });
  cleanups.push(async () => { finish.resolve(); await connection.dispose(); });
  const { post } = await batchConnection(connection);
  const result = post([holdRequest(1), holdRequest(2)]);
  await ready.promise;
  expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'cancel 1' } })).status).toBe(202);
  expect([...controllers.values()].some(({ signal }) => signal.aborted)).toBe(false);
  await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'cancel 1' } });
  await cancelled.promise; finish.resolve();
  const wire = await (await result).json();
  console.log(JSON.stringify({ publicCancellationProbe: wire }));
  expect(wire).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 1, result: expect.objectContaining({ isError: true }) }),
    expect.objectContaining({ id: 2, result: { content: [{ type: 'text', text: 'done' }] } }),
  ]));
});

it('does not cancel another request when the first request in a resource-owning batch is cancelled', async () => {
  const ready = deferred<void>(); const cancelled = deferred<void>(); const finish = deferred<void>();
  const signals = new Map<number, AbortSignal>(); const release = vi.fn(async () => {});
  const connection = await startLocalMcpConnection((_request, _connection, resources) => {
    const server = new McpServer({ name: 'batch-cancel', version: '1' });
    const requests = resources.bind(server, new AbortController().signal, async (messages, _signal, retain) => {
      for (const message of messages) if (message.method === 'tools/call') await retain(String(message.id), async () => release);
    });
    server.registerTool('hold', { inputSchema: z.object({ index: z.number() }) }, async ({ index }, extra) => requests.run(extra.requestId, async (active) => {
      signals.set(index, active); active.addEventListener('abort', () => cancelled.resolve(), { once: true });
      if (signals.size === 2) ready.resolve();
      await finish.promise;
      return { content: [{ type: 'text', text: String(index) }] };
    })); return server;
  });
  cleanups.push(async () => { finish.resolve(); await connection.dispose(); });
  const { post } = await batchConnection(connection);
  const result = post([holdRequest(1), holdRequest(2)]).then(async (response) => ({ wire: await response.json() }), (error: unknown) => ({ error: String(error) }));
  await ready.promise;
  await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'cancel 1' } });
  expect([...signals.values()].every((signal) => !signal.aborted)).toBe(true);
  await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await cancelled.promise; finish.resolve();
  const outcome = await result;
  console.log(JSON.stringify({ requestCancellationComparison: outcome, signals: [...signals].map(([id, signal]) => ({ id, aborted: signal.aborted })) }));
  expect(signals.get(2)!.aborted).toBe(false);
  expect(outcome).toMatchObject({ wire: expect.arrayContaining([expect.objectContaining({ id: 2 })]) });
});

it.each(['all-cancelled', 'disconnect', 'shutdown'] as const)('settles every batch action before releasing shared resources on %s', async (mode) => {
  const ready = deferred<void>(); const aborted = deferred<void>(); const finish = deferred<void>(); const released = deferred<void>();
  const signals: AbortSignal[] = [];
  const release = vi.fn(async () => { released.resolve(); });
  const connection = await startLocalMcpConnection((_request, _connection, resources) => {
    const server = new McpServer({ name: 'batch-ending', version: '1' });
    const requests = resources.bind(server, new AbortController().signal, async (messages, _signal, retain) => {
      if (messages.some((message) => message.method === 'tools/call')) await retain('shared', async () => release);
    });
    server.registerTool('hold', { inputSchema: z.object({ index: z.number() }) }, async (_value, extra) => requests.run(extra.requestId, async (signal) => {
      signals.push(signal);
      signal.addEventListener('abort', () => { if (signals.every((value) => value.aborted)) aborted.resolve(); }, { once: true });
      if (signals.length === 2) ready.resolve();
      await finish.promise;
      return { content: [{ type: 'text', text: 'late success' }] };
    }));
    return server;
  });
  cleanups.push(async () => { finish.resolve(); await connection.dispose(); });
  const { post } = await batchConnection(connection);
  const disconnected = new AbortController();
  const result = post([holdRequest(1), holdRequest(2)], AbortSignal.any([disconnected.signal, AbortSignal.timeout(5000)]))
    .then(async (response) => response.json()).catch(() => undefined);
  await ready.promise;
  let closing: Promise<void> | undefined;
  if (mode === 'all-cancelled') {
    for (const requestId of [1, 2]) await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
  } else if (mode === 'shutdown') closing = connection.dispose();
  else disconnected.abort();
  await aborted.promise;
  expect(release).not.toHaveBeenCalled();
  finish.resolve(); await released.promise; await closing;
  const wire = await result;
  if (mode === 'all-cancelled') expect(wire).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 1, result: expect.objectContaining({ isError: true }) }),
    expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: true }) }),
  ]));
  else expect(wire).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

it('preserves the HTTP request context through SDK dispatch and retains resources until the response finishes', async () => {
  const entered = deferred<void>(); const ending = deferred<void>(); const send = deferred<void>(); const released = deferred<void>();
  const events: string[] = [];
  const connection = await startLocalMcpConnection((_request, _connection, responses) => {
    const server = new McpServer({ name: 'resources', version: '1' });
    const requests = responses.bind(server, new AbortController().signal, async (messages, _signal, retain) => {
      if (messages.some((message) => message.method === 'tools/call')) await retain('resource', async () => async () => { events.push('released'); released.resolve(); });
    });
    server.registerTool('hold', { inputSchema: z.object({}) }, async (_args, extra) => requests.run(extra.requestId, async () => {
      events.push('handler'); entered.resolve();
      return { content: [{ type: 'text', text: 'done' }] };
    }));
    return server;
  });
  const client = new Client({ name: 'resources', version: '1' });
  cleanups.push(async () => { send.resolve(); await client.close(); await connection.dispose(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } }));
  const end = ServerResponse.prototype.end;
  vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function(this: ServerResponse, ...args: Parameters<typeof end>) {
    this.prependOnceListener('finish', () => events.push('finish'));
    void send.promise.then(() => { end.apply(this, args); });
    events.push('end-called');
    ending.resolve();
    return this;
  });
  const response = client.callTool({ name: 'hold', arguments: {} });
  await entered.promise;
  await ending.promise;
  expect(events).toEqual(['handler', 'end-called']);
  send.resolve();
  expect((await response).content).toEqual([{ type: 'text', text: 'done' }]);
  await released.promise;
  expect(events).toEqual(['handler', 'end-called', 'finish', 'released']);
});

it.each(['cancel', 'shutdown'] as const)('reclaims an unfinished HTTP request on %s after the action settles', async (mode) => {
  const entered = deferred<void>(); const cancelled = deferred<void>(); const finish = deferred<void>(); const released = deferred<void>();
  const release = vi.fn(async () => { released.resolve(); });
  const connection = await startLocalMcpConnection((_request, _connection, responses) => {
    const server = new McpServer({ name: 'resources', version: '1' });
    const requests = responses.bind(server, new AbortController().signal, async (messages, _signal, retain) => {
      if (messages.some((message) => message.method === 'tools/call')) await retain('resource', async () => release);
    });
    server.registerTool('hold', { inputSchema: z.object({}) }, async (_args, extra) => requests.run(extra.requestId, async (active) => {
      active.addEventListener('abort', () => cancelled.resolve(), { once: true });
      entered.resolve(); await finish.promise;
      expect(active.aborted).toBe(true);
      return { content: [{ type: 'text', text: 'late success' }] };
    }));
    return server;
  });
  const client = new Client({ name: 'resources', version: '1' });
  const errors: string[] = [];
  client.onerror = (error) => { errors.push(error.message); };
  cleanups.push(async () => { finish.resolve(); await client.close(); await connection.dispose(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } }));
  const controller = new AbortController();
  const request = client.callTool({ name: 'hold', arguments: {} }, undefined, { signal: controller.signal });
  const result = request.then((value) => ({ value }), () => ({ failed: true }));
  await entered.promise;
  const closing = mode === 'shutdown' ? connection.dispose() : undefined;
  if (mode === 'cancel') controller.abort();
  expect(release).not.toHaveBeenCalled();
  await cancelled.promise;
  finish.resolve();
  await released.promise; await closing;
  expect(await result).toEqual({ failed: true });
  expect(release).toHaveBeenCalledOnce();
  if (mode === 'cancel') {
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain('hold');
    console.log(JSON.stringify({ lateCancelledResponse: { request: await result, nextRequest: 'listTools succeeded', errors } }));
  }
});

it('keeps acquisition ownership separate between two HTTP responses for the same repository', async () => {
  const entered = deferred<void>(); const secondAttempt = deferred<void>(); const finish = deferred<void>();
  const events: string[] = []; const directory = getGlobalConfigDir();
  const connection = await startLocalMcpConnection((_request, _connection, responses) => {
    const server = new McpServer({ name: 'resources', version: '1' });
    const input = z.object({ index: z.number() });
    const requests = responses.bind(server, new AbortController().signal, async (messages, signal, retain) => {
      const message = messages.find((message) => message.method === 'tools/call');
      if (message === undefined) return;
      const { index } = input.parse(message.params?.arguments);
      await retain(directory, async () => {
        events.push(`attempt-${index}`); if (index === 2) secondAttempt.resolve();
        const release = await acquireRepositoryAssignmentLocks(directory, [directory], signal);
        return async () => { await release(); events.push(`released-${index}`); };
      });
    });
    server.registerTool('hold', { inputSchema: input }, async ({ index }, extra) => requests.run(extra.requestId, async () => {
      events.push(`prepared-${index}`);
      if (index === 1) { entered.resolve(); await finish.promise; }
      return { content: [{ type: 'text', text: String(index) }] };
    }));
    return server;
  });
  const client = new Client({ name: 'resources', version: '1' });
  cleanups.push(async () => { finish.resolve(); await client.close(); await connection.dispose(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } }));
  const first = client.callTool({ name: 'hold', arguments: { index: 1 } }); await entered.promise;
  const second = client.callTool({ name: 'hold', arguments: { index: 2 } }); await secondAttempt.promise;
  expect(events).toEqual(['attempt-1', 'prepared-1', 'attempt-2']);
  finish.resolve();
  expect((await first).content).toEqual([{ type: 'text', text: '1' }]);
  expect((await second).content).toEqual([{ type: 'text', text: '2' }]);
  await connection.dispose();
  expect(events).toEqual(['attempt-1', 'prepared-1', 'attempt-2', 'released-1', 'prepared-2', 'released-2']);
});
