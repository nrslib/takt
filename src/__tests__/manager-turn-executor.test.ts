import { afterEach, expect, it, vi } from 'vitest';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { makeProvider } from './test-helpers.js';
import { diagnosticLoggingSuppressed, withoutDiagnosticLogging } from '../shared/utils/diagnostic-context.js';
import * as mcpAdapters from '../infra/providers/mcp/index.js';
import { MAX_PROCESS_PROGRESS_BYTES } from '../core/daemon/processProtocol.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const call = vi.fn<ProviderAgent['call']>();
  const executor = createManagerTurnExecutor('/repository', { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  const invalidateSession = vi.fn(async () => {});
  const input: ManagerTurnInput = { prompt: 'user text', sessionId: 'prior-session',
    abortSignal: new AbortController().signal, assignment: { kind: 'repository', repositoryDirectory: '/repository' }, recovery: { context: '{"pending":{"revision":4}}', invalidateSession } };
  return { call, executor, input, invalidateSession };
}
const success = { persona: 'manager', status: 'done' as const, content: '', timestamp: new Date(),
  structuredOutput: { message: 'reply', summary: null }, sessionId: 'fresh-session' };

it.each([true, false, undefined])('uses fresh business context only for patrols when patrol=%s', async (patrol) => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockResolvedValue(success);
  await executor.execute({ ...input, patrol });
  await executor.execute({ ...input, patrol });
  expect(call).toHaveBeenCalledTimes(2);
  for (const [prompt, options] of call.mock.calls) {
    expect(options.sessionId).toBe(patrol ? undefined : input.sessionId);
    expect(options.callerManagedSession).toBe(true);
    if (patrol) {
      expect(prompt).toContain(input.prompt);
      expect(prompt).toContain(input.recovery!.context);
    } else expect(prompt).toBe(input.prompt);
  }
  expect(invalidateSession).not.toHaveBeenCalled();
});

it('does not invalidate the conversation session when a patrol retries an overflow', async () => {
  const { call, executor, input, invalidateSession } = fixture();
  call.mockRejectedValueOnce(new Error('Prompt is too long'));
  call.mockResolvedValueOnce(success);
  expect(await executor.execute({ ...input, patrol: true })).toMatchObject({ message: 'reply' });
  expect(call).toHaveBeenCalledTimes(2);
  for (const [prompt, options] of call.mock.calls) {
    expect(options.sessionId).toBeUndefined();
    expect(prompt).toContain(input.recovery!.context);
  }
  expect(invalidateSession).not.toHaveBeenCalled();
});

it('reports activity changes and Bash descriptions without commands or other tool inputs', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  const events: StreamEvent[] = [
    { type: 'thinking', data: { thinking: 'private reasoning' } },
    { type: 'thinking', data: { thinking: 'more private reasoning' } },
    { type: 'tool_use', data: { id: 'first', tool: 'Bash', input: { description: 'コードを\n読む\u001b[31m', command: 'grep patrol source.ts', timeout: 1000 } } },
    { type: 'tool_use', data: { id: 'second', tool: 'Bash', input: { description: 'コードを 読む', command: 'another private command' } } },
    { type: 'tool_output', data: { tool: 'Bash', output: 'private output' } },
    { type: 'tool_use', data: { id: 'third', tool: 'Read', input: { file: 'private path' } } },
    { type: 'tool_result', data: { id: 'third', content: 'private file', isError: false } },
    { type: 'tool_result', data: { completedToolIds: ['first', 'second'], content: 'private result', isError: false } },
    { type: 'text', data: { text: 'partial reply' } },
    { type: 'text', data: { text: 'more partial reply' } },
  ];
  call.mockImplementation(async (_prompt, options) => {
    for (const event of events) options.onStream!(event);
    return success;
  });
  await executor.execute({ ...input, onActivity });
  const expected = [{ kind: 'thinking' }, { kind: 'tool', tool: 'Bash', description: 'コードを 読む' }, { kind: 'tool', tool: 'Read' },
    { kind: 'tool', tool: 'Bash', description: 'コードを 読む' }, { kind: 'waiting' }, { kind: 'responding' }];
  expect(onActivity.mock.calls.map(([value]) => value)).toEqual(expected);
  onActivity.mockClear();
  await executor.execute({ ...input, onActivity });
  expect(onActivity.mock.calls.map(([value]) => value)).toEqual(expected);
});

it.each([undefined, '', ' \t\n ', 42, null, { text: '説明' }])('uses the Bash name when its description is unusable: %j', async (description) => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: { description, command: 'private command' } } });
    return success;
  });
  await executor.execute({ ...input, onActivity });
  expect(onActivity.mock.calls.map(([value]) => value)).toEqual([{ kind: 'tool', tool: 'Bash' }]);
});

it('does not extract descriptions from commands, nested inputs, or non-Bash tools', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: {
      command: 'コードを読む', nested: { description: 'コードを読む' },
    } } });
    options.onStream!({ type: 'tool_use', data: { id: 'read', tool: 'Read', input: { description: 'コードを読む' } } });
    return success;
  });
  await executor.execute({ ...input, onActivity });
  expect(onActivity.mock.calls.map(([value]) => value)).toEqual([{ kind: 'tool', tool: 'Bash' }, { kind: 'tool', tool: 'Read' }]);
});

it('bounds Bash descriptions and removes terminal controls and Unicode line separators', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: {
      description: '\u001b[31mコード\r\nを\t読む\u2028次\u2029行\u0000' + 'あ'.repeat(300), command: 'private command',
    } } });
    return success;
  });
  await executor.execute({ ...input, onActivity });
  expect(onActivity).toHaveBeenCalledExactlyOnceWith({ kind: 'tool', tool: 'Bash',
    description: ('コード を 読む 次 行' + 'あ'.repeat(300)).slice(0, 256) });
});

it('updates same-name Bash descriptions and restores the remaining parallel tool description', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'first', tool: 'Bash', input: { description: '最初の調査' } } });
    options.onStream!({ type: 'tool_use', data: { id: 'second', tool: 'Bash', input: { description: '次の調査' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'second', content: 'private result', isError: false } });
    options.onStream!({ type: 'tool_result', data: { id: 'first', content: 'private result', isError: false } });
    return success;
  });
  await executor.execute({ ...input, onActivity });
  expect(onActivity.mock.calls.map(([value]) => value)).toEqual([
    { kind: 'tool', tool: 'Bash', description: '最初の調査' },
    { kind: 'tool', tool: 'Bash', description: '次の調査' },
    { kind: 'tool', tool: 'Bash', description: '最初の調査' }, { kind: 'waiting' },
  ]);
});

it('does not split a surrogate pair when bounding a Bash description', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: { description: 'a'.repeat(255) + '🙂' } } });
    return success;
  });
  await executor.execute({ ...input, onActivity });
  expect(onActivity).toHaveBeenCalledExactlyOnceWith({ kind: 'tool', tool: 'Bash', description: 'a'.repeat(255) });
});

it('flushes text chunks once before tool activity and flushes the final block before returning the structured reply', async () => {
  const { call, executor, input } = fixture();
  const observed: unknown[] = [];
  const onText = vi.fn((message: string) => { observed.push(message); });
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: 'コードを' } });
    options.onStream!({ type: 'text', data: { text: '読みます。' } });
    expect(onText).not.toHaveBeenCalled();
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: {} } });
    expect(observed).toEqual(['コードを読みます。', { kind: 'tool', tool: 'Bash' }]);
    options.onStream!({ type: 'tool_result', data: { id: 'bash', content: '', isError: false } });
    options.onStream!({ type: 'text', data: { text: '調べがつきました。' } });
    return success;
  });
  const turnInput = { ...input, onText, onActivity: (activity: unknown) => {
    if (typeof activity === 'object' && activity !== null && 'kind' in activity && activity.kind === 'tool') observed.push(activity);
  } };
  const result = await executor.execute(turnInput);
  observed.push(result.message);
  expect(observed).toEqual(['コードを読みます。', { kind: 'tool', tool: 'Bash' }, '調べがつきました。', 'reply']);
  expect(onText).toHaveBeenCalledTimes(2);
});

it('does not publish whitespace-only text blocks', async () => {
  const { call, executor, input } = fixture();
  const onText = vi.fn<(message: string) => void>();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: ' \t\n ' } });
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: {} } });
    options.onStream!({ type: 'text', data: { text: '\n ' } });
    return success;
  });
  const turnInput = { ...input, onText };
  await executor.execute(turnInput);
  expect(onText).not.toHaveBeenCalled();
});

it('truncates a text block at the progress byte limit without breaking UTF-8', async () => {
  const { call, executor, input } = fixture();
  const onText = vi.fn<(message: string) => void>();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: 'あ'.repeat(6000) } });
    options.onStream!({ type: 'text', data: { text: '後続' } });
    return success;
  });
  const turnInput = { ...input, onText };
  await executor.execute(turnInput);
  expect(onText).toHaveBeenCalledExactlyOnceWith('あ'.repeat(Math.floor(MAX_PROCESS_PROGRESS_BYTES / 3)));
});

it('discards unflushed and late text after the same turn is cancelled', async () => {
  const { call, executor, input } = fixture();
  const controller = new AbortController();
  const onText = vi.fn<(message: string) => void>();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: '表示済み' } });
    options.onStream!({ type: 'tool_use', data: { id: 'bash', tool: 'Bash', input: {} } });
    expect(onText).toHaveBeenCalledExactlyOnceWith('表示済み');
    options.onStream!({ type: 'text', data: { text: '未確定' } });
    controller.abort();
    options.onStream!({ type: 'text', data: { text: '遅延' } });
    options.onStream!({ type: 'tool_use', data: { id: 'late', tool: 'Read', input: {} } });
    return success;
  });
  const turnInput = { ...input, onText, abortSignal: controller.signal };
  await expect(executor.execute(turnInput)).rejects.toThrow();
  expect(onText).toHaveBeenCalledExactlyOnceWith('表示済み');
});

it('does not forward invalid tool labels or activity after cancellation', async () => {
  const { call, executor, input } = fixture();
  const onActivity = vi.fn();
  const controller = new AbortController();
  call.mockImplementationOnce(async (_prompt, options) => {
    for (const tool of ['Bash\nprivate command', '\x1b[2J', 'B'.repeat(129)]) {
      options.onStream!({ type: 'tool_use', data: { id: 'invalid', tool, input: {} } });
    }
    controller.abort();
    options.onStream!({ type: 'thinking', data: { thinking: 'late' } });
    return success;
  });
  await expect(executor.execute({ ...input, onActivity, abortSignal: controller.signal })).rejects.toThrow();
  expect(onActivity).not.toHaveBeenCalled();
});

it('reports each provider stream event including tool results that cannot be parsed', async () => {
  const { call, executor, input } = fixture();
  const onProviderOutput = vi.fn();
  const events: StreamEvent[] = [
    { type: 'text', data: { text: 'working' } },
    { type: 'thinking', data: { thinking: 'planning' } },
    { type: 'tool_use', data: { id: 'add', tool: 'takt_add_workspace_repository', input: {} } },
    { type: 'tool_result', data: { id: 'add', content: 'invalid JSON', isError: false } },
    { type: 'tool_output', data: { tool: 'Bash', output: 'running' } },
  ];
  call.mockImplementationOnce(async (_prompt, options) => {
    for (const [index, event] of events.entries()) {
      options.onStream!(event);
      expect(onProviderOutput).toHaveBeenCalledTimes(index + 1);
    }
    return success;
  });
  const turnInput = { ...input, onProviderOutput };
  expect(await executor.execute(turnInput)).toMatchObject({ message: 'reply' });
});

it('reports provider output on both the initial call and the overflow retry', async () => {
  const { call, executor, input } = fixture();
  const onProviderOutput = vi.fn();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: 'first attempt' } });
    throw new Error('Prompt is too long');
  });
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: 'second attempt' } });
    return success;
  });
  const turnInput = { ...input, onProviderOutput };
  expect(await executor.execute(turnInput)).toMatchObject({ message: 'reply' });
  expect(onProviderOutput).toHaveBeenCalledTimes(2);
});

it('propagates cancellation to the provider without retrying the aborted turn', async () => {
  const { call, executor, input } = fixture();
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  call.mockImplementationOnce((_prompt, options) => new Promise((_resolve, reject) => {
    providerSignal = options.abortSignal;
    options.abortSignal!.addEventListener('abort', () => reject(new Error('provider interrupted')), { once: true });
  }));
  const running = executor.execute({ ...input, abortSignal: controller.signal });
  const observed = expect(running).rejects.toThrow('provider interrupted');
  controller.abort();
  await observed;
  expect(providerSignal?.aborted).toBe(true);
  expect(call).toHaveBeenCalledOnce();
});

it('allows callers without an output callback to complete after thirty minutes', async () => {
  vi.useFakeTimers();
  const { call, executor, input } = fixture();
  let finish!: () => void;
  call.mockImplementationOnce((_prompt, options) => new Promise((resolve) => {
    options.onStream!({ type: 'text', data: { text: 'conversation output' } });
    finish = () => resolve(success);
  }));
  const running = executor.execute(input);
  try {
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(call.mock.calls[0]![1].abortSignal?.aborted).toBe(false);
    finish();
    expect(await running).toMatchObject({ message: 'reply', sessionId: 'fresh-session' });
  } finally { finish(); await running; }
});

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

it.each(['result', 'throw'] as const)('retries prompt overflow from a provider %s once without a conversation facade', async (failure) => {
  const { call, executor, input } = fixture();
  if (failure === 'throw') call.mockRejectedValueOnce(new Error('Prompt is too long'));
  else call.mockResolvedValueOnce({ ...success, status: 'error', error: 'Prompt is too long' });
  call.mockResolvedValueOnce(success);
  expect(await executor.execute({ ...input, recovery: undefined })).toMatchObject({ sessionId: 'fresh-session', message: 'reply' });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0]![1].sessionId).toBe('prior-session');
  expect(call.mock.calls[1]![1].sessionId).toBeUndefined();
  expect(call.mock.calls[1]![0]).toBe(call.mock.calls[0]![0]);
  expect(call.mock.calls[1]![1].callerManagedSession).toBeUndefined();
});

it.each(['result', 'throw'] as const)('returns a second overflow %s failure without a third attempt', async (failure) => {
  const { call, executor, input } = fixture();
  if (failure === 'throw') call.mockRejectedValue(new Error('Prompt is too long'));
  else call.mockResolvedValue({ ...success, status: 'error', error: 'Prompt is too long' });
  await expect(executor.execute(input)).rejects.toThrow('Prompt is too long');
  expect(call).toHaveBeenCalledTimes(2);
});

it('never retries overflow after using a tool or after cancellation', async () => {
  const { call, executor, input } = fixture();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream?.({ type: 'tool_use', data: { tool: 'Bash', id: 'tool-1', input: {} } });
    throw new Error('Prompt is too long');
  });
  await expect(executor.execute(input)).rejects.toThrow('Prompt is too long');
  expect(call).toHaveBeenCalledOnce();
  const controller = new AbortController();
  call.mockImplementationOnce(async () => { controller.abort(); throw new Error('Prompt is too long'); });
  await expect(executor.execute({ ...input, abortSignal: controller.signal })).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(2);
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

it('releases prepared MCP when the final text observer throws', async () => {
  const { call, input, executor, prepared } = mcpFixture();
  call.mockImplementationOnce(async (_prompt, options) => {
    options.onStream!({ type: 'text', data: { text: '終了前の本文' } });
    return success;
  });
  await expect(executor.execute({ ...input, onText() { throw new Error('observer failed'); } })).rejects.toThrow('observer failed');
  expect(prepared.dispose).toHaveBeenCalledOnce();
});

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
