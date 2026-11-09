import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationRuntime } from '../features/manager/conversationRuntime.js';
import { deferred } from './helpers/daemon-turn.js';
import { makeProvider } from './test-helpers.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';

const doubles = vi.hoisted(() => ({ plan: vi.fn(), connect: vi.fn(), preflight: vi.fn(), dispose: vi.fn(), execute: vi.fn() }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', () => ({ TAKT_MANAGER_MCP_SERVER_NAME: 'takt', connectManagerMcp: doubles.connect }));
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

it.each(['model', 'prompt', 'mcp', 'language', 'permission'] as const)('replaces setup and invalidates its context key when %s changes', async (change) => {
  const first = await runtime.resolve(assignment, signal);
  if (change === 'model') plan.ctx.model = 'model-B';
  if (change === 'prompt') plan.strategy.systemPrompt = 'manager-B';
  if (change === 'mcp') plan.ctx.mcpServers = { extra: { command: 'node', args: ['server.js'] } };
  if (change === 'language') plan.ctx.lang = 'ja';
  if (change === 'permission') plan.ctx.aiReviewPermissions = true;
  const second = await runtime.resolve(assignment, signal);
  expect(second.contextKey).not.toBe(first.contextKey); expect(second.executor).not.toBe(first.executor);
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(doubles.dispose.mock.invocationCallOrder[0]).toBeLessThan(doubles.connect.mock.invocationCallOrder[1]!);
});

it.each([true, false])('passes resolved AI permission review to preflight (%s)', async (aiReviewPermissions) => {
  plan.ctx.aiReviewPermissions = aiReviewPermissions;
  await runtime.resolve(assignment, signal);
  expect(doubles.preflight).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'full', aiReviewPermissions }));
});

it.each([
  { repositories: ['/first', '/second'], cwd: '/first' },
  { repositories: [], cwd: '/config/workspaces/workspace-1' },
])('uses the workspace manager cwd for configuration: %j', async ({ repositories, cwd }) => {
  await runtime.resolve({ kind: 'workspace', workspaceId: 'workspace-1', name: 'workspace', repositoryDirectories: repositories }, signal);
  expect(doubles.plan).toHaveBeenCalledWith(cwd, { repositoryDirectories: repositories });
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

it.each([false, true])('keeps the tool scope and patrol metadata active only during the current non-aborted turn (patrol: %s)', async (patrol) => {
  const prepared = await runtime.resolve(assignment, signal);
  const { turnScope, conversationTurn } = doubles.connect.mock.calls[0]![3] as {
    turnScope: import('../features/daemonTurn/toolScope.js').TurnToolScope;
    conversationTurn(): { patrol: boolean } | undefined;
  };
  expect(conversationTurn()).toBeUndefined();
  await expect(turnScope.run(async () => 'outside')).rejects.toThrow('No active tool turn');
  const controller = new AbortController(); const gate = deferred<void>(); const started = deferred<void>();
  doubles.execute.mockImplementation(async () => { started.resolve(); await gate.promise; return { message: 'done', summary: null }; });
  const execution = prepared.executor.execute({ prompt: 'message',
    sessionId: 'session', assignment: { kind: 'repository', repositoryDirectory: '/repository' }, abortSignal: controller.signal, patrol });
  await started.promise;
  await expect(turnScope.run(async () => 'inside')).resolves.toBe('inside');
  expect(conversationTurn()).toEqual({ patrol });
  controller.abort();
  expect(conversationTurn()).toBeUndefined();
  await expect(turnScope.run(async () => 'outside')).rejects.toThrow();
  gate.resolve(); await execution;
  expect(conversationTurn()).toBeUndefined();
  await expect(turnScope.run(async () => 'outside')).rejects.toThrow();
});
