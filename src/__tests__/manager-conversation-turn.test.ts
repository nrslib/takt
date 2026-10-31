import { afterEach, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../core/models/index.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { MANAGER_ASSIGNMENT_HEADER, withManagerAssignment } from '../features/manager/assignment.js';
import * as adapters from '../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../infra/config/runtime-provider/mcp-schema.js';
import { acquireOpenCodeClient, resetSharedServerPool } from '../infra/opencode/server-pool.js';
import type { ResolvedMcpServers } from '../infra/providers/mcp/types.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

const server = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn() }));
vi.mock('../infra/opencode/server-process.js', () => ({ startOpenCodeServer: server.start }));
vi.mock('../infra/opencode/runtime.js', () => ({
  openCodeRuntimeSelection: () => ({ generation: 'v1', command: 'opencode' }),
  resolveOpenCodeRuntime: async () => ({ generation: 'v1', command: 'opencode', version: '1.18.2' }),
}));
vi.mock('node:net', () => ({ createServer: () => ({
  unref() {}, on() {}, listen(_port: number, _host: string, callback: () => void) { callback(); },
  address: () => ({ port: 62000 }), close(callback: () => void) { callback(); },
}) }));
afterEach(() => { resetSharedServerPool(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const operationId = '550e8400-e29b-41d4-a716-446655440002';
const nextOperationId = '550e8400-e29b-41d4-a716-446655440003';
const assignment = { kind: 'repository' as const, repositoryDirectory: '/repository' };
const response = { persona: 'manager', status: 'done' as const, content: '', timestamp: new Date(),
  structuredOutput: { message: 'done', summary: null } };
const input = { prompt: 'merge', instruction: 'merge', sessionId: undefined, abortSignal: new AbortController().signal,
  assignment, configDirectory: '/config' };

it('preserves operation identity and JSON business context when reconstructing a rejected session', async () => {
  const call = vi.fn<ProviderAgent['call']>()
    .mockResolvedValueOnce({ ...response, status: 'error', failureCategory: 'session_continuation_unsupported', error: 'cannot resume' })
    .mockResolvedValueOnce({ ...response, sessionId: 'fresh-session' });
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  const context = { pending: { revision: 4 } };
  const invalidateSession = vi.fn(async () => {});

  expect(await executor.execute({ ...input, sessionId: 'prior-session', conversationOperationId: operationId,
    recovery: { context: JSON.stringify(context), invalidateSession } })).toMatchObject({ message: 'done', sessionId: 'fresh-session' });

  expect(invalidateSession).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0]![1].sessionId).toBe('prior-session');
  expect(call.mock.calls[1]![1].sessionId).toBeUndefined();
  for (const [prompt] of call.mock.calls) {
    expect(prompt).toContain(operationId);
    expect(prompt).toContain(input.prompt);
  }
  expect(JSON.parse(call.mock.calls[1]![0].split('Business context (not approval): ')[1]!)).toEqual(context);
});

it.each(['claude', 'codex'] as const)('keeps %s MCP configuration and disposal unchanged across turns', async (providerType) => {
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue(response);
  const dispose = vi.fn(async () => {});
  const prepare = vi.fn(async (_servers: ResolvedMcpServers) => ({ dispose }));
  vi.spyOn(adapters, 'createMcpAdapter').mockReturnValue({ validate: vi.fn(),
    prepare, classifyFailure: () => ({ category: 'provider_error' }) });
  const config: McpServerConfig = { type: 'http', url: 'http://localhost:1234',
    headers: { [MANAGER_ASSIGNMENT_HEADER]: 'assignment', authorization: 'Bearer test' } };
  const original = structuredClone(config);
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType, lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }), mcpServers: { [TAKT_MANAGER_MCP_SERVER_NAME]: config } },
    permissionJudge: { resolution: { provider: providerType, model: undefined, providerOptions: {} },
      language: 'en', systemPrompt: 'judge', managerPersona: 'manager', managerPolicy: 'policy' },
    strategy: { systemPrompt: 'manager' } });
  for (const id of [operationId, nextOperationId, undefined]) await executor.execute({ ...input, conversationOperationId: id });
  const expected = { [TAKT_MANAGER_MCP_SERVER_NAME]: withManagerAssignment(config, assignment) };
  expect(prepare.mock.calls.map(([servers]) => servers.identity)).toEqual(Array(3).fill(buildMcpServerSetIdentity(expected)));
  for (const [, options] of call.mock.calls) {
    expect(options.mcpServers).toEqual(expected);
    expect(options.callerManagedMcp).toBe(true);
    expect(options.preparedMcp).toEqual({ dispose });
  }
  expect(call.mock.calls[0]![0]).toContain(operationId);
  expect(call.mock.calls[1]![0]).toContain(nextOperationId);
  expect(call.mock.calls[1]![0]).not.toContain(operationId);
  expect(call.mock.calls[2]![0]).toBe(input.prompt);
  expect(dispose).toHaveBeenCalledTimes(3);
  expect(config).toEqual(original);
});

it('reuses one OpenCode server with the main MCP identity across conversation and autonomous turns', async () => {
  server.start.mockResolvedValue({ client: { sdkState: { directory: '/sdk', stale: false } },
    close: server.close, onError: () => () => {} });
  const adapter = adapters.createMcpAdapter('opencode');
  const prepare = vi.spyOn(adapter, 'prepare');
  vi.spyOn(adapters, 'createMcpAdapter').mockReturnValue(adapter);
  const clients: unknown[] = [];
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const acquired = await acquireOpenCodeClient('probe/model', undefined, undefined,
      options.abortSignal, options.sessionId, options.preparedMcp);
    try { clients.push(acquired.client); return response; }
    finally { acquired.release(); }
  });
  const config: McpServerConfig = { type: 'stdio', command: 'node', args: ['mcp'], env: { TAKT_CONFIG_DIR: '/config' } };
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'opencode', lang: 'en', model: 'probe/model',
    provider: makeProvider({ setup: () => ({ call }) }), mcpServers: { [TAKT_MANAGER_MCP_SERVER_NAME]: config } },
    strategy: { systemPrompt: 'manager' } });
  for (const id of [operationId, nextOperationId, undefined, operationId]) {
    await executor.execute({ ...input, conversationOperationId: id, sessionId: 'manager-session' });
  }
  const expected = { [TAKT_MANAGER_MCP_SERVER_NAME]: withManagerAssignment(config, assignment) };
  expect(prepare.mock.calls.map(([servers]) => servers.identity)).toEqual(Array(4).fill(buildMcpServerSetIdentity(expected)));
  expect(server.start).toHaveBeenCalledOnce();
  expect(server.close).not.toHaveBeenCalled();
  expect(clients).toHaveLength(4);
  expect(clients.every((client) => client === clients[0])).toBe(true);
  for (const [, options] of call.mock.calls) expect(options.mcpServers).toEqual(expected);
  resetSharedServerPool();
  expect(server.close).toHaveBeenCalledOnce();
});
