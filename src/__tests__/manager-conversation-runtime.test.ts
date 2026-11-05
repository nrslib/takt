import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationRuntime } from '../features/manager/conversationRuntime.js';
import { deferred } from './helpers/daemon-turn.js';
import { makeProvider } from './test-helpers.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';

const doubles = vi.hoisted(() => ({ plan: vi.fn(), connect: vi.fn(), preflight: vi.fn(), dispose: vi.fn(), execute: vi.fn() }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', () => ({ TAKT_MANAGER_MCP_SERVER_NAME: 'takt', connectManagerMcp: doubles.connect }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({ sensitivePaths: [] }) }));
vi.mock('../features/manager/turnExecutor.js', () => ({ createManagerTurnExecutor: () => ({ execute: doubles.execute }) }));
let plan: ManagerConversationPlan;
let runtime: ReturnType<typeof createConversationRuntime>;
const assignment = { kind: 'repository' as const, repositoryDirectory: '/repository', repositoryDirectories: ['/repository'] };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  plan = { ctx: { providerType: 'mock', model: 'model-A', lang: 'en', provider: makeProvider({ preflight: doubles.preflight }) }, strategy: { systemPrompt: 'manager-A' } };
  doubles.plan.mockImplementation(() => plan);
  doubles.connect.mockResolvedValue({ servers: {}, dispose: doubles.dispose });
  runtime = createConversationRuntime('/config');
});
afterEach(async () => { vi.restoreAllMocks(); await runtime.close().catch(() => {}); });

it('reuses compatible setup while resolving the current plan for every turn', async () => {
  const first = await runtime.resolve(assignment, signal);
  expect(await runtime.resolve(assignment, signal)).toBe(first);
  expect(doubles.plan).toHaveBeenCalledTimes(2); expect(doubles.connect).toHaveBeenCalledOnce(); expect(doubles.preflight).toHaveBeenCalledOnce();
});

it('passes the current attachment provider and model overrides to plan resolution for each turn', async () => {
  const first = { provider: 'mock' as const, model: 'chosen-A' };
  const second = { provider: 'codex' as const, model: 'chosen-B' };
  await runtime.resolve(assignment, signal, first);
  expect(doubles.plan).toHaveBeenLastCalledWith('/repository', first);
  plan = { ...plan, ctx: { ...plan.ctx, providerType: 'codex', model: 'chosen-B' } };
  const resolved = await runtime.resolve(assignment, signal, second);
  expect(doubles.plan).toHaveBeenLastCalledWith('/repository', second);
  expect(resolved).toMatchObject({ provider: 'codex', model: 'chosen-B' });
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it.each(['model', 'prompt', 'mcp', 'language'] as const)('replaces setup and invalidates its context key when %s changes', async (change) => {
  const first = await runtime.resolve(assignment, signal);
  if (change === 'model') plan.ctx.model = 'model-B';
  if (change === 'prompt') plan.strategy.systemPrompt = 'manager-B';
  if (change === 'mcp') plan.ctx.mcpServers = { extra: { command: 'node', args: ['server.js'] } };
  if (change === 'language') plan.ctx.lang = 'ja';
  const second = await runtime.resolve(assignment, signal);
  expect(second.contextKey).not.toBe(first.contextKey); expect(second.executor).not.toBe(first.executor);
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(doubles.dispose.mock.invocationCallOrder[0]).toBeLessThan(doubles.connect.mock.invocationCallOrder[1]!);
});

it('disposes MCP after failed preflight and permits another preparation', async () => {
  doubles.preflight.mockRejectedValueOnce(new Error('preflight failed'));
  await expect(runtime.resolve(assignment, signal)).rejects.toThrow('preflight failed');
  expect(doubles.dispose).toHaveBeenCalledOnce();
  await runtime.resolve(assignment, signal); expect(doubles.connect).toHaveBeenCalledTimes(2);
});

it('waits for MCP disposal during close and reports its failure', async () => {
  await runtime.resolve(assignment, signal);
  doubles.dispose.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it.each([false, true])('exposes only active non-aborted turn metadata to MCP (patrol: %s)', async (patrol) => {
  const prepared = await runtime.resolve(assignment, signal);
  const options = doubles.connect.mock.calls[0]![3] as { conversationTurn(): { operationId: string; directorMessage: boolean; patrol?: boolean } | undefined };
  expect(options.conversationTurn()).toBeUndefined();
  const controller = new AbortController(); const gate = deferred<void>(); const started = deferred<void>();
  doubles.execute.mockImplementation(async () => { started.resolve(); await gate.promise; return { message: 'done', summary: null }; });
  const execution = prepared.executor.execute({ prompt: 'message', instruction: 'message', configDirectory: '/config',
    sessionId: 'session', assignment: { kind: 'repository', repositoryDirectory: '/repository' }, abortSignal: controller.signal,
    conversationOperationId: 'operation', directorMessage: !patrol, patrol });
  await started.promise;
  expect(options.conversationTurn()).toEqual({ operationId: 'operation', directorMessage: !patrol, patrol });
  controller.abort();
  expect(options.conversationTurn()).toBeUndefined();
  gate.resolve(); await execution;
  expect(options.conversationTurn()).toBeUndefined();
});
