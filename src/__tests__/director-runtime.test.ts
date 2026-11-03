import { deferred } from './helpers/daemon-turn.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDaemonConversationRuntime, prepareDirectorTurn } from '../features/director/conversationRuntime.js';
import { DIRECTOR_TOOL_ALLOWLIST } from '../features/director/mcp.js';
import * as directorMcp from '../features/director/mcp.js';

const doubles = vi.hoisted(() => ({ plan: vi.fn(), connect: vi.fn(), executor: vi.fn(), preflight: vi.fn(),
  managers: vi.fn(), dispose: vi.fn(), execute: vi.fn(), resolve: vi.fn(), close: vi.fn() }));
vi.mock('../features/director/conversationPlan.js', () => ({ createDirectorConversationPlan: doubles.plan }));
vi.mock('../features/mcp/localConnection.js', () => ({ startLocalMcpConnection: doubles.connect }));
vi.mock('../features/director/turnExecutor.js', () => ({ createDirectorTurnExecutor: doubles.executor }));
vi.mock('../features/manager/conversationRuntime.js', () => ({ createConversationRuntime: doubles.managers }));
const signal = () => new AbortController().signal;
const notices = { tellManager: vi.fn(async () => ({})), notifyHuman: vi.fn(async (message: string) => ({ id: 'notification', message })) };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.plan.mockReturnValue({ cwd: '/config', systemPrompt: 'director', ctx: { provider: { preflight: doubles.preflight },
    providerType: 'mock', lang: 'en' } });
  doubles.connect.mockResolvedValue({ config: { type: 'http', url: 'http://localhost:1234' }, dispose: doubles.dispose });
  doubles.executor.mockReturnValue({ execute: doubles.execute });
  doubles.managers.mockReturnValue({ resolve: doubles.resolve, close: doubles.close });
});
afterEach(() => vi.restoreAllMocks());

it('prepares an isolated readonly turn and passes its connection to the executor', async () => {
  const abortSignal = signal();
  const prepared = await prepareDirectorTurn('/config', notices, abortSignal, {});
  expect(doubles.preflight).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'readonly', strictToolAllowlist: DIRECTOR_TOOL_ALLOWLIST, abortSignal }));
  expect(doubles.executor).toHaveBeenCalledWith(doubles.plan.mock.results[0]!.value, expect.objectContaining({ type: 'http' }));
  expect(prepared).toMatchObject({ provider: 'mock', language: 'en', model: null });
  expect(doubles.dispose).not.toHaveBeenCalled();
  await prepared.dispose();
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it.each(['preflight', 'executor'] as const)('disposes the connection after %s preparation failure', async (boundary) => {
  doubles[boundary].mockImplementationOnce(() => { throw new Error('preparation failed'); });
  await expect(prepareDirectorTurn('/config', notices, signal(), {})).rejects.toThrow('preparation failed');
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it('refuses cancelled preparation before allocating a connection', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareDirectorTurn('/config', notices, controller.signal, {})).rejects.toThrow();
  expect(doubles.connect).not.toHaveBeenCalled();
});

it.each([false, true])('releases a human turn connection on completion, including failure=%s', async (fails) => {
  if (fails) doubles.execute.mockRejectedValueOnce(new Error('turn failed'));
  else doubles.execute.mockResolvedValueOnce({ message: 'done' });
  const runtime = createDaemonConversationRuntime('/config', notices);
  const prepared = await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  const turn = { prompt: 'human message', instruction: 'human message', sessionId: 'human', assignment: undefined,
    configDirectory: '/config', abortSignal: signal() };
  if (fails) await expect(prepared.executor.execute(turn)).rejects.toThrow('turn failed');
  else expect(await prepared.executor.execute(turn)).toEqual({ message: 'done' });
  expect(doubles.dispose).toHaveBeenCalledOnce();
  await runtime.close();
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
});

it('delegates manager conversations and closes unresolved director resources despite another cleanup failure', async () => {
  doubles.close.mockRejectedValueOnce(new Error('manager cleanup failed'));
  const runtime = createDaemonConversationRuntime('/config', notices);
  const assignment = { kind: 'repository' as const, repositoryDirectory: '/repo', repositoryDirectories: ['/repo'] };
  const abortSignal = signal();
  await runtime.resolve(assignment, abortSignal);
  expect(doubles.resolve).toHaveBeenCalledWith(assignment, abortSignal, undefined);
  await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, abortSignal);
  await expect(runtime.close()).rejects.toThrow('cleanup failed');
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it('shares an awaited release between the caller and runtime close without disposing another turn', async () => {
  let finish!: () => void;
  const disposing = deferred<void>();
  doubles.dispose.mockImplementationOnce(() => { disposing.resolve(); return new Promise<void>((resolve) => { finish = resolve; }); });
  const otherDispose = vi.fn();
  const runtime = createDaemonConversationRuntime('/config', notices);
  const first = await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  doubles.connect.mockResolvedValueOnce({ config: { type: 'http', url: 'http://localhost:1235' }, dispose: otherDispose });
  await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  const releasing = first.release!();
  const releasingAgain = first.release!();
  await disposing.promise;
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(otherDispose).not.toHaveBeenCalled();
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await Promise.all([releasing, releasingAgain, closing]);
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(otherDispose).toHaveBeenCalledOnce();
});

it('propagates a release failure and shares it with concurrent runtime cleanup', async () => {
  doubles.dispose.mockRejectedValueOnce(new Error('connection cleanup failed'));
  const runtime = createDaemonConversationRuntime('/config', notices);
  const prepared = await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  const releasing = prepared.release!();
  const closing = runtime.close();
  await expect(releasing).rejects.toThrow('connection cleanup failed');
  await expect(closing).rejects.toBeInstanceOf(AggregateError);
  await expect(prepared.release!()).rejects.toThrow('connection cleanup failed');
  expect(doubles.dispose).toHaveBeenCalledOnce();
});

it('waits for director MCP tool cleanup before completing the turn', async () => {
  const server = vi.spyOn(directorMcp, 'createDirectorMcpServer');
  const runtime = createDaemonConversationRuntime('/config', notices);
  const prepared = await runtime.resolve({ kind: 'daemon', repositoryDirectories: [] }, signal());
  doubles.connect.mock.calls[0]![0]();
  const scope = server.mock.calls[0]![3]!;
  const started = deferred<void>(); const cleanup = deferred<void>();
  doubles.execute.mockImplementation(async () => {
    void scope.run(async () => { started.resolve(); await cleanup.promise; });
    return { message: 'done' };
  });
  const execution = prepared.executor.execute({ prompt: 'message', instruction: 'message', sessionId: undefined,
    assignment: undefined, configDirectory: '/config', abortSignal: signal() });
  await started.promise;
  let completed = false; void execution.then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false); expect(doubles.dispose).not.toHaveBeenCalled();
  cleanup.resolve(); await execution; await runtime.close();
  expect(doubles.dispose).toHaveBeenCalledOnce();
});
