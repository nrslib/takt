import { afterEach, expect, it, vi } from 'vitest';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';
import { diagnosticLoggingSuppressed, withoutDiagnosticLogging } from '../shared/utils/diagnostic-context.js';
import * as mcpAdapters from '../infra/providers/mcp/index.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const call = vi.fn<ProviderAgent['call']>();
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  const invalidateSession = vi.fn(async () => {});
  const input: ManagerTurnInput = { prompt: 'user text', instruction: 'user text', sessionId: 'prior-session',
    abortSignal: new AbortController().signal, assignment: { kind: 'repository', repositoryDirectory: '/repository' },
    configDirectory: '/config', recovery: { context: '{"pending":{"revision":4}}', invalidateSession } };
  return { call, executor, input, invalidateSession };
}
const success = { persona: 'manager', status: 'done' as const, content: '', timestamp: new Date(),
  structuredOutput: { message: 'reply', summary: null }, sessionId: 'fresh-session' };

it('invalidates a rejected resume before one fresh call and preserves its business context', async () => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockResolvedValueOnce({ ...success, status: 'error', failureCategory: 'session_continuation_unsupported', error: 'cannot resume' });
  call.mockImplementationOnce(async (prompt, options) => {
    expect(invalidateSession).toHaveBeenCalledOnce();
    expect(options).toMatchObject({ callerManagedSession: true, sessionId: undefined });
    expect(prompt).toContain(input.recovery!.context);
    return success;
  });
  expect(await executor.execute(input)).toMatchObject({ message: 'reply', sessionId: 'fresh-session' });
  expect(call).toHaveBeenCalledTimes(2);
});

it('returns a successful reply containing the failure category name without invalidating or replaying its session', async () => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockResolvedValueOnce({ ...success, structuredOutput: { message: 'session_continuation_unsupported', summary: null } });
  expect(await executor.execute(input)).toMatchObject({ message: 'session_continuation_unsupported' });
  expect(call).toHaveBeenCalledExactlyOnceWith(input.prompt, expect.objectContaining({ sessionId: input.sessionId }));
  expect(invalidateSession).not.toHaveBeenCalled();
});

it.each(['generic', 'tools', 'second-recovery'] as const)('does not replay the turn after %s failure', async (failure) => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockImplementationOnce(async (_prompt, options) => {
    if (failure === 'tools') options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: {} } });
    return { ...success, status: 'error', error: failure === 'generic' ? 'provider failed' : 'cannot resume',
      ...(failure === 'generic' ? {} : { failureCategory: 'session_continuation_unsupported' as const }) };
  });
  call.mockRejectedValueOnce(new Error('prompt is too long'));
  await expect(executor.execute(input)).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(failure === 'second-recovery' ? 2 : 1);
  expect(invalidateSession).toHaveBeenCalledTimes(failure === 'generic' ? 0 : 1);
});

it('shares a single recovery budget between overflow and an explicit resume rejection', async () => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockRejectedValueOnce(new Error('prompt is too long'));
  call.mockResolvedValueOnce({ ...success, status: 'error', error: 'cannot resume', failureCategory: 'session_continuation_unsupported' });
  await expect(executor.execute(input)).rejects.toMatchObject({ failureCategory: 'session_continuation_unsupported' });
  expect(call).toHaveBeenCalledTimes(2); expect(invalidateSession).toHaveBeenCalledOnce();
});

it('does not retain a rejected session ID when fresh success omits a new ID', async () => {
  const { call, executor, input } = fixture();
  call.mockResolvedValueOnce({ ...success, status: 'error', error: 'cannot resume', failureCategory: 'session_continuation_unsupported' });
  call.mockResolvedValueOnce({ ...success, sessionId: undefined });
  expect((await executor.execute(input)).sessionId).toBeUndefined();
});

it('suppresses diagnostics only within the private async call while another call remains observable', async () => {
  const { call, executor, input } = fixture();
  let release!: () => void;
  const observed: boolean[] = [];
  call.mockImplementationOnce(async () => {
    observed.push(diagnosticLoggingSuppressed());
    await new Promise<void>((resolve) => { release = resolve; });
    observed.push(diagnosticLoggingSuppressed());
    return success;
  });
  const privateTurn = executor.execute(input);
  try {
    expect(diagnosticLoggingSuppressed()).toBe(false);
    expect(withoutDiagnosticLogging(() => diagnosticLoggingSuppressed())).toBe(true);
  } finally { release(); }
  await privateTurn;
  expect(observed).toEqual([true, true]);
  call.mockImplementationOnce(async () => { expect(diagnosticLoggingSuppressed()).toBe(false); return success; });
  await executor.execute({ ...input, recovery: undefined });
  expect(call.mock.calls[1]![1].callerManagedSession).toBeUndefined();
});

function mcpFixture() {
  const { call, input, invalidateSession } = fixture();
  let available = true;
  const prepared = { dispose: vi.fn(async () => { available = false; }) };
  const prepare = vi.fn(async () => prepared);
  vi.spyOn(mcpAdapters, 'createMcpAdapter').mockReturnValue({ validate: vi.fn(), prepare, classifyFailure: () => ({ category: 'provider_error' }) });
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    mcpServers: { context: { command: 'manager-context-server' } }, provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  const checkCall = () => {
    expect(available).toBe(true);
    expect(prepared.dispose).not.toHaveBeenCalled();
    expect(call.mock.calls.at(-1)![1]).toMatchObject({ callerManagedMcp: true, preparedMcp: prepared });
  };
  return { call, input, invalidateSession, executor, prepared, prepare, checkCall };
}

it.each(['success', 'generic', 'second-failure', 'running-abort', 'between-attempt-abort'] as const)(
  'retains MCP through its last consumer and releases it after %s', async (outcome) => {
    const { call, input, invalidateSession, executor, prepared, prepare, checkCall } = mcpFixture();
    const controller = new AbortController();
    let release!: () => void;
    const invalidation = new Promise<void>((resolve) => { release = resolve; });
    if (outcome === 'between-attempt-abort') invalidateSession.mockImplementationOnce(() => invalidation);
    call.mockImplementationOnce(async () => {
      checkCall();
      if (outcome === 'success') return success;
      if (outcome === 'running-abort') {
        controller.abort();
        throw controller.signal.reason;
      }
      return { ...success, status: 'error', error: 'provider failed',
        ...(outcome === 'generic' ? {} : { failureCategory: 'session_continuation_unsupported' as const }) };
    });
    if (outcome === 'second-failure') call.mockImplementationOnce(async () => { checkCall(); throw new Error('prompt is too long'); });
    const running = executor.execute({ ...input, abortSignal: controller.signal });
    const observed = outcome === 'success' ? expect(running).resolves.toMatchObject({ message: 'reply' }) : expect(running).rejects.toThrow();
    if (outcome === 'between-attempt-abort') {
      try {
        await vi.waitFor(() => expect(invalidateSession).toHaveBeenCalledOnce());
        expect(prepared.dispose).not.toHaveBeenCalled();
        controller.abort();
      } finally { release(); }
    }
    await observed;
    expect(call).toHaveBeenCalledTimes(outcome === 'second-failure' ? 2 : 1);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepared.dispose).toHaveBeenCalledOnce();
  },
);

it.each([false, true])('awaits final MCP cleanup and propagates its rejection (%s)', async (fails) => {
  const { call, input, executor, prepared } = mcpFixture();
  let finish!: () => void;
  prepared.dispose.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    finish = () => fails ? reject(new Error('cleanup failed')) : resolve();
  }));
  call.mockResolvedValueOnce(success);
  let settled = false;
  const running = executor.execute(input).finally(() => { settled = true; });
  const observed = fails ? expect(running).rejects.toThrow('cleanup failed') : expect(running).resolves.toMatchObject({ message: 'reply' });
  try {
    await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
  } finally { finish(); }
  await observed;
});
