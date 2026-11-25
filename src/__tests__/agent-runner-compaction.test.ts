import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../agents/runner.js';
import type { RunAgentOptions } from '../agents/types.js';
import type { AgentResponse } from '../core/models/index.js';
import type {
  Provider,
  ProviderAgent,
  ProviderCallOptions,
} from '../infra/providers/types.js';

const { getProviderMock } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
}));

vi.mock('../infra/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/providers/index.js')>();
  return { ...actual, getProvider: getProviderMock };
});

function makeResponse(
  content: string,
  sessionId: string,
  status: AgentResponse['status'] = 'done',
): AgentResponse {
  return {
    persona: 'default',
    status,
    content,
    timestamp: new Date('2026-11-12T00:00:00.000Z'),
    sessionId,
    ...(status === 'error' ? { error: content } : {}),
  };
}

function makeProvider(agent: ProviderAgent): Provider {
  return {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => true,
    setup: () => agent,
  };
}

function makeRunOptions(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  return {
    cwd: '/worktree',
    executionPhase: 1,
    sessionId: 'previous-thread',
    abortSignal: new AbortController().signal,
    childProcessEnv: { TAKT_TEST_ENV: 'preserved' },
    edit: false,
    progressNotesRecorder: { observe: vi.fn(), finish: vi.fn(), recoveryInstruction: () => 'original Phase 1 instruction' },
    resolvedExecution: {
      provider: 'codex',
      model: 'gpt-test',
      providerOptions: {
        codex: {
          networkAccess: false,
          reasoningEffort: 'high',
        },
      },
      permissionMode: 'readonly',
    },
    ...overrides,
  };
}

describe('AgentRunner compaction recovery', () => {
  beforeEach(() => {
    getProviderMock.mockReset();
  });

  it('passes a fixed context window through and does not look up or promote it', async () => {
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      expect(options.contextWindow).toBe(400_000);
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-fixed' } });
      return makeResponse('completed', 'window-fixed');
    });
    const getContextWindowLimits = vi.fn();
    getProviderMock.mockReturnValue({ ...makeProvider({ call }), getContextWindowLimits });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-fixed',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-fixed',
        providerOptions: { codex: { contextWindow: 400_000 } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first task', options);
    await new AgentRunner().run(undefined, 'second task', options);

    expect(call).toHaveBeenCalledTimes(2);
    expect(getContextWindowLimits).not.toHaveBeenCalled();
  });

  it('passes an explicit initial window to the provider and promotes it for recovery and the next call', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-object' } });
      }
      return makeResponse('completed', 'window-object');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_task, options) => {
        windows.push(options.contextWindow);
        return makeResponse('recovered', 'window-object');
      },
    );
    getProviderMock.mockReturnValue({
      ...makeProvider({ call, recoverFromCompaction, assessCompactedResponse: async () => ({ decision: 'needs_recovery' }) }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000 }),
    });
    const options = makeRunOptions({
      sessionId: 'window-object',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-object',
        providerOptions: { codex: { contextWindow: { initial: 500_000, auto_expand: true } } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first', options);
    await new AgentRunner().run(undefined, 'second', { ...options, executionPhase: 2 });

    expect(windows).toEqual([500_000, 872_000, 872_000]);
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
  });

  it('does not reuse a promotion when the explicit setting changes or the maximum becomes unknown', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-object-change' } });
      }
      return makeResponse('completed', 'window-object-change');
    });
    const getContextWindowLimits = vi.fn()
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce({ default: 272_000, maximum: 500_000 });
    getProviderMock.mockReturnValue({ ...makeProvider({ call }), getContextWindowLimits });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-object-change',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-object-change',
        providerOptions: { codex: { contextWindow: { initial: 500_000, auto_expand: true } } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first', options);
    const changed = {
      ...options,
      resolvedExecution: {
        ...options.resolvedExecution!,
        providerOptions: { codex: { contextWindow: { initial: 400_000, auto_expand: true } } },
      },
    };
    await new AgentRunner().run(undefined, 'changed setting', changed);
    await new AgentRunner().run(undefined, 'unknown maximum', changed);
    await new AgentRunner().run(undefined, 'disabled', {
      ...options,
      resolvedExecution: {
        ...options.resolvedExecution!,
        providerOptions: { codex: { contextWindow: { initial: 400_000, auto_expand: false } } },
      },
    });
    await new AgentRunner().run(undefined, 'original setting restored', options);
    await new AgentRunner().run(undefined, 'maximum lowered', options);

    expect(windows).toEqual([500_000, 400_000, 400_000, 400_000, 500_000, 500_000]);
    expect(getContextWindowLimits).toHaveBeenCalledTimes(5);
  });

  it('keeps auto promotion within its own provider session', async () => {
    const windows: Array<[string | undefined, number | undefined]> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push([options.sessionId, options.contextWindow]);
      if (options.sessionId === 'window-session-a' && windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: options.sessionId } });
      }
      return makeResponse('completed', options.sessionId!);
    });
    getProviderMock.mockReturnValue({
      ...makeProvider({ call }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000 }),
    });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-session-a',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-session',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first task', options);
    await new AgentRunner().run(undefined, 'other session', { ...options, sessionId: 'window-session-b' });
    await new AgentRunner().run(undefined, 'same session', options);

    expect(windows).toEqual([
      ['window-session-a', undefined],
      ['window-session-b', undefined],
      ['window-session-a', 500_000],
    ]);
  });

  it('bounds a promoted session to the current native maximum', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length <= 2) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-shrinking' } });
      }
      return makeResponse('completed', 'window-shrinking');
    });
    const getContextWindowLimits = vi.fn()
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce({ default: 272_000, maximum: 500_000 });
    getProviderMock.mockReturnValue({ ...makeProvider({ call }), getContextWindowLimits });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-shrinking',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-shrinking',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });
    await new AgentRunner().run(undefined, 'first', options);
    await new AgentRunner().run(undefined, 'second', options);
    await new AgentRunner().run(undefined, 'third', options);
    expect(windows).toEqual([undefined, 500_000, 500_000]);
  });

  it('does not promote a new response session from a foreign compaction event', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'refused-session' } });
      }
      return makeResponse('completed', 'new-session');
    });
    getProviderMock.mockReturnValue({
      ...makeProvider({ call }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000 }),
    });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'refused-session',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-foreign',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });
    await new AgentRunner().run(undefined, 'first', options);
    await new AgentRunner().run(undefined, 'second', { ...options, sessionId: 'new-session' });
    expect(windows).toEqual([undefined, undefined]);
  });

  it('does not carry a prior session promotion into a new response session', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-old' } });
        return makeResponse('completed', 'window-old');
      }
      if (windows.length === 2) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-old' } });
        return makeResponse('completed', 'window-new');
      }
      return makeResponse('completed', 'window-new');
    });
    getProviderMock.mockReturnValue({
      ...makeProvider({ call }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000 }),
    });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-old',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-new',
        providerOptions: { codex: { contextWindow: { initial: 500_000, auto_expand: true } } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first', options);
    await new AgentRunner().run(undefined, 'second', options);
    await new AgentRunner().run(undefined, 'third', { ...options, sessionId: 'window-new' });

    expect(windows).toEqual([500_000, 872_000, 500_000]);
  });

  it('resets the native window before recovering a new session from an ID-less compaction event', async () => {
    const windows: Array<[string | undefined, number | undefined]> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push([options.sessionId, options.contextWindow]);
      if (call.mock.calls.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-old-recovery' } });
        return makeResponse('completed', 'window-old-recovery');
      }
      if (call.mock.calls.length === 2) {
        options.onStream?.({ type: 'context_compacted', data: {} });
        return makeResponse('needs recovery', 'window-new-recovery');
      }
      return makeResponse('completed', 'window-new-recovery');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_task, options) => {
        windows.push([options.sessionId, options.contextWindow]);
        return makeResponse('recovered', 'window-new-recovery');
      },
    );
    getProviderMock.mockReturnValue({
      ...makeProvider({ call, recoverFromCompaction, assessCompactedResponse: async () => ({ decision: 'needs_recovery' }) }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000 }),
    });
    const options = makeRunOptions({
      sessionId: 'window-old-recovery',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-new-recovery',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first', { ...options, executionPhase: 2 });
    const recovered = await new AgentRunner().run(undefined, 'second', options);
    await new AgentRunner().run(undefined, 'third', { ...options, executionPhase: 2, sessionId: 'window-new-recovery' });

    expect(recovered.content).toBe('recovered');
    expect(windows).toEqual([
      ['window-old-recovery', undefined],
      ['window-old-recovery', 500_000],
      ['window-new-recovery', undefined],
      ['window-new-recovery', undefined],
    ]);
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
  });

  it('does not reuse a promoted override when the current native default is unknown', async () => {
    const windows: Array<number | undefined> = [];
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      windows.push(options.contextWindow);
      if (windows.length === 1) {
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-unknown' } });
      }
      return makeResponse('completed', 'window-unknown');
    });
    const getContextWindowLimits = vi.fn()
      .mockResolvedValueOnce({ default: 272_000, maximum: 872_000 })
      .mockResolvedValueOnce(undefined);
    getProviderMock.mockReturnValue({ ...makeProvider({ call }), getContextWindowLimits });
    const options = makeRunOptions({
      executionPhase: 2,
      sessionId: 'window-unknown',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-unknown',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });

    await new AgentRunner().run(undefined, 'first task', options);
    await new AgentRunner().run(undefined, 'after config change', options);

    expect(windows).toEqual([undefined, undefined]);
  });

  it('promotes the same provider session before recovery without changing its session ID', async () => {
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      expect(options.contextWindow).toBeUndefined();
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-recovery' } });
      return makeResponse('needs recovery', 'window-recovery');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_task, options) => {
        expect(options.contextWindow).toBe(500_000);
        expect(options.sessionId).toBe('window-recovery');
        return makeResponse('completed', 'window-recovery');
      },
    );
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async () => ({ decision: 'needs_recovery' }),
    );
    getProviderMock.mockReturnValue({
      ...makeProvider({ call, recoverFromCompaction, assessCompactedResponse }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000, effectivePercent: 95 }),
    });
    const options = makeRunOptions({
      sessionId: 'window-recovery',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-recovery',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });

    const result = await new AgentRunner().run(undefined, 'short task', options);

    expect(result.content).toBe('completed');
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
  });

  it('keeps a completed response and its promoted capacity for the next call', async () => {
    const call = vi.fn<ProviderAgent['call']>(async (_task, options) => {
      if (call.mock.calls.length === 1) {
        expect(options.contextWindow).toBeUndefined();
        options.onStream?.({ type: 'context_compacted', data: { sessionId: 'window-complete' } });
      } else {
        expect(options.contextWindow).toBe(500_000);
      }
      return makeResponse('completed', 'window-complete');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async () => ({ decision: 'complete' }),
    );
    getProviderMock.mockReturnValue({
      ...makeProvider({ call, recoverFromCompaction, assessCompactedResponse }),
      getContextWindowLimits: async () => ({ default: 272_000, maximum: 872_000, effectivePercent: 95 }),
    });
    const options = makeRunOptions({
      sessionId: 'window-complete',
      resolvedExecution: {
        provider: 'codex', model: 'synthetic-window-complete',
        providerOptions: { codex: { contextWindow: 'auto' } },
        permissionMode: 'readonly',
      },
    });

    expect((await new AgentRunner().run(undefined, 'short task', options)).content).toBe('completed');
    expect(recoverFromCompaction).not.toHaveBeenCalled();
    await new AgentRunner().run(undefined, 'next phase', { ...options, executionPhase: 2 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('recovers once after repeated compaction events and returns only the recovery result', async () => {
    const order: string[] = [];
    const onStream = vi.fn();
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_prompt, options) => {
        order.push('recover');
        options.onStream?.({
          type: 'result',
          data: { result: 'recovered', sessionId: 'current-thread', success: true },
        });
        return makeResponse('recovered', 'current-thread');
      },
    );
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
      order.push('call');
      for (let index = 0; index < 2; index += 1) {
        options.onStream?.({
          type: 'context_compacted',
          data: { sessionId: 'current-thread' },
        });
      }
      options.onStream?.({
        type: 'result',
        data: { result: 'lost instruction', sessionId: 'current-thread', success: true },
      });
      return makeResponse('lost instruction', 'current-thread');
    });
    const options = makeRunOptions({ onStream });
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(undefined, 'original Phase 1 instruction', options);

    expect(response).toMatchObject({ status: 'done', content: 'recovered', sessionId: 'current-thread' });
    expect(order).toEqual(['call', 'recover']);
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledWith('original Phase 1 instruction', {
      ...call.mock.calls[0]![1],
      onStream: expect.any(Function),
      sessionId: 'current-thread',
    });
    const successfulResults = onStream.mock.calls.filter(([event]) => (
      event.type === 'result' && event.data.success
    ));
    expect(successfulResults).toEqual([[
      {
        type: 'result',
        data: { result: 'recovered', sessionId: 'current-thread', success: true },
      },
    ]]);
  });

  it.each([
    'APPROVE: the assigned review is complete.',
    'REJECT: the assigned review found a concrete defect in src/example.ts.',
  ])('preserves a completed review response after compaction: %s', async (content) => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: content, sessionId: 'current-thread', success: true } });
      return makeResponse(content, 'current-thread');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async () => ({ decision: 'complete' }),
    );
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream }));

    expect(result).toMatchObject({ status: 'done', content, sessionId: 'current-thread' });
    expect(recoverFromCompaction).not.toHaveBeenCalled();
    expect(assessCompactedResponse).toHaveBeenCalledOnce();
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      { type: 'result', data: { result: content, sessionId: 'current-thread', success: true } },
    ]]);
  });

  it.each([
    {
      name: 'all cache fields missing',
      initialCache: {}, assessmentCache: {}, recoveryCache: {}, expectedCache: {},
    },
    {
      name: 'one cache field missing from an attempt',
      initialCache: { cachedInputTokens: 0, cacheCreationInputTokens: 2, cacheReadInputTokens: 3 },
      assessmentCache: { cachedInputTokens: 1, cacheReadInputTokens: 0 },
      recoveryCache: { cachedInputTokens: 2, cacheCreationInputTokens: 4, cacheReadInputTokens: 1 },
      expectedCache: { cachedInputTokens: 3, cacheReadInputTokens: 4 },
    },
    {
      name: 'all cache fields known including zero',
      initialCache: { cachedInputTokens: 0, cacheCreationInputTokens: 2, cacheReadInputTokens: 0 },
      assessmentCache: { cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1 },
      recoveryCache: { cachedInputTokens: 0, cacheCreationInputTokens: 1, cacheReadInputTokens: 4 },
      expectedCache: { cachedInputTokens: 0, cacheCreationInputTokens: 3, cacheReadInputTokens: 5 },
    },
  ])('recovers a role-lost review with $name and keeps assessment output out of the result stream', async ({
    initialCache, assessmentCache, recoveryCache, expectedCache,
  }) => {
    const onStream = vi.fn();
    const recorder = { observe: vi.fn(), finish: vi.fn(), recoveryInstruction: () => 'Review the remaining change' };
    const lost = 'I cannot implement this fix because I only have read access.';
    const reviewed = 'REJECT: src/example.ts has an unchecked failure path.';
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: lost, sessionId: 'current-thread', success: true } });
      return { ...makeResponse(lost, 'current-thread'), providerUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, usageMissing: false, ...initialCache } };
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(async (_instruction, options) => {
      options.onStream?.({ type: 'result', data: { result: reviewed, sessionId: 'current-thread', success: true } });
      return { ...makeResponse(reviewed, 'current-thread'), providerUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, usageMissing: false, ...recoveryCache } };
    });
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(async (_instruction, response) => ({
      decision: response.content === lost ? 'needs_recovery' : 'complete',
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, usageMissing: false, ...assessmentCache },
    }));
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream, progressNotesRecorder: recorder }));

    expect(result).toMatchObject({ status: 'done', content: reviewed, sessionId: 'current-thread' });
    expect(result.providerUsage).toEqual({
      inputTokens: 21, outputTokens: 6, totalTokens: 27, usageMissing: false, ...expectedCache,
    });
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
    expect(recoverFromCompaction.mock.calls[0]![0]).toBe('Review the remaining change');
    expect(assessCompactedResponse).toHaveBeenCalledOnce();
    expect(recorder.finish).toHaveBeenCalledTimes(2);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      { type: 'result', data: { result: reviewed, sessionId: 'current-thread', success: true } },
    ]]);
  });

  it('keeps recovering beyond three attempts when recoveries use tools and returns the completed review', async () => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: 'unresolved', sessionId: 'current-thread', success: true } });
      return makeResponse('unresolved', 'current-thread');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(async (_instruction, options): Promise<AgentResponse> => {
      const content = recoverFromCompaction.mock.calls.length === 5 ? 'REJECT: review complete' : 'unresolved';
      options.onStream?.({ type: 'tool_use', data: { tool: 'Read', input: {}, id: 'read' } });
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: content, sessionId: 'current-thread', success: true } });
      return makeResponse(content, 'current-thread');
    });
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async (_instruction, response) => ({ decision: response.content === 'unresolved' ? 'needs_recovery' : 'complete' }),
    );
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream }));

    expect(result).toMatchObject({ status: 'done', content: 'REJECT: review complete' });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(5);
    expect(assessCompactedResponse).toHaveBeenCalledTimes(6);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      { type: 'result', data: { result: 'REJECT: review complete', success: true, sessionId: 'current-thread' } },
    ]]);
  });

  it('reports assessment failure instead of accepting or replaying the candidate', async () => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: 'candidate', sessionId: 'current-thread', success: true } });
      return makeResponse('candidate', 'current-thread');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async () => ({ decision: 'error', error: 'assessment unavailable', failureCategory: 'provider_error' }),
    );
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream }));

    expect(result).toMatchObject({ status: 'error', error: 'assessment unavailable', sessionId: 'current-thread' });
    expect(recoverFromCompaction).not.toHaveBeenCalled();
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      expect.objectContaining({ type: 'result', data: expect.objectContaining({ success: false, error: 'assessment unavailable' }) }),
    ]]);
  });

  it('keeps the original response when the provider has no recovery capability', async () => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
      options.onStream?.({
        type: 'context_compacted',
        data: { sessionId: 'current-thread' },
      });
      options.onStream?.({
        type: 'result',
        data: { result: 'unchanged', sessionId: 'current-thread', success: true },
      });
      return makeResponse('unchanged', 'current-thread');
    });
    getProviderMock.mockReturnValue(makeProvider({ call }));

    const response = await new AgentRunner().run(
      undefined,
      'original Phase 1 instruction',
      makeRunOptions({ onStream }),
    );

    expect(response).toMatchObject({ status: 'done', content: 'unchanged' });
    expect(call).toHaveBeenCalledOnce();
    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: { result: 'unchanged', sessionId: 'current-thread', success: true },
    });
  });

  it('does not resend a completed ordinary task after compaction without a progress notes recorder', async () => {
    const onStream = vi.fn();
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const result = { type: 'result', data: { result: 'completed', sessionId: 'current-thread', success: true } } as const;
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.(result);
      return makeResponse('completed', 'current-thread');
    });
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(undefined, 'ordinary task', makeRunOptions({
      onStream, progressNotesRecorder: undefined,
    }));

    expect(response).toMatchObject({ status: 'done', content: 'completed' });
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).not.toHaveBeenCalled();
    expect(onStream).toHaveBeenCalledWith(result);
  });

  it('does not invoke recovery without a provider compaction event', async () => {
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const call = vi.fn<ProviderAgent['call']>(async () => makeResponse('unchanged', 'current-thread'));
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(
      undefined,
      'original Phase 1 instruction',
      makeRunOptions(),
    );

    expect(response).toMatchObject({ status: 'done', content: 'unchanged' });
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).not.toHaveBeenCalled();
  });

  it('does not invoke Phase 1 recovery for another execution phase', async () => {
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
      options.onStream?.({
        type: 'context_compacted',
        data: { sessionId: 'current-thread' },
      });
      return makeResponse('report', 'current-thread');
    });
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(
      undefined,
      'report instruction',
      makeRunOptions({ executionPhase: 2 }),
    );

    expect(response).toMatchObject({ status: 'done', content: 'report' });
    expect(recoverFromCompaction).not.toHaveBeenCalled();
  });

  it('returns a rate-limited response when the compaction assessment is rate limited', async () => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: 'candidate', sessionId: 'current-thread', success: true } });
      return { ...makeResponse('candidate', 'current-thread'), structuredOutput: { step: 1 }, partialOutput: 'candidate', retryCount: 2 };
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>();
    const rateLimitInfo = {
      provider: 'codex' as const,
      detectedAt: new Date('2026-11-25T00:00:00.000Z'),
      resetAtRaw: '3:00 PM',
      source: 'sdk_error' as const,
    };
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(async () => ({
      decision: 'error',
      error: "You've hit your usage limit. Try again at 3:00 PM.",
      errorKind: 'rate_limit',
      rateLimitInfo,
    }));
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream }));

    expect(result).toMatchObject({
      status: 'rate_limited',
      content: '',
      error: "You've hit your usage limit. Try again at 3:00 PM.",
      errorKind: 'rate_limit',
      rateLimitInfo,
      sessionId: 'current-thread',
    });
    expect(result.failureCategory).toBeUndefined();
    expect(result.structuredOutput).toBeUndefined();
    expect(result.partialOutput).toBeUndefined();
    expect(result.retryCount).toBe(2);
    expect(recoverFromCompaction).not.toHaveBeenCalled();
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      {
        type: 'result',
        data: {
          result: "You've hit your usage limit. Try again at 3:00 PM.",
          sessionId: 'current-thread',
          success: false,
          error: "You've hit your usage limit. Try again at 3:00 PM.",
        },
      },
    ]]);
  });

  it('stops after three recoveries when every turn reports another compaction', async () => {
    const onStream = vi.fn();
    const runCompactedTurn = async (options: ProviderCallOptions) => {
      options.onStream?.({
        type: 'context_compacted',
        data: { sessionId: 'current-thread' },
      });
      options.onStream?.({
        type: 'result',
        data: { result: 'lost instruction', sessionId: 'current-thread', success: true },
      });
      return makeResponse('lost instruction', 'current-thread');
    };
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => runCompactedTurn(options));
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_prompt, options) => runCompactedTurn(options),
    );
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(
      undefined,
      'original Phase 1 instruction',
      makeRunOptions({ onStream }),
    );

    expect(response).toMatchObject({
      status: 'error',
      error: expect.any(String),
      sessionId: 'current-thread',
    });
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledTimes(3);
    expect(onStream.mock.calls.filter(([event]) => (
      event.type === 'result' && event.data.success
    ))).toHaveLength(0);
    expect(onStream.mock.calls.filter(([event]) => (
      event.type === 'result' && !event.data.success
    ))).toHaveLength(1);
  });

  it('returns recovery failure without retrying or reporting a successful result', async () => {
    const onStream = vi.fn();
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async (_prompt, options) => {
        options.onStream?.({
          type: 'result',
          data: {
            result: 'recovery failed',
            sessionId: 'current-thread',
            success: false,
            error: 'recovery failed',
          },
        });
        return makeResponse('recovery failed', 'current-thread', 'error');
      },
    );
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
      options.onStream?.({
        type: 'context_compacted',
        data: { sessionId: 'current-thread' },
      });
      options.onStream?.({
        type: 'result',
        data: { result: 'lost instruction', sessionId: 'current-thread', success: true },
      });
      return makeResponse('lost instruction', 'current-thread');
    });
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    const response = await new AgentRunner().run(
      undefined,
      'original Phase 1 instruction',
      makeRunOptions({ onStream }),
    );

    expect(response).toMatchObject({ status: 'error', error: 'recovery failed' });
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledOnce();
    expect(onStream.mock.calls.filter(([event]) => (
      event.type === 'result' && event.data.success
    ))).toHaveLength(0);
  });

  it('preserves the initial session when a successful response omits its session ID', async () => {
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(
      async () => makeResponse('recovered', 'previous-thread'),
    );
    const call = vi.fn<ProviderAgent['call']>(async (_prompt, options: ProviderCallOptions) => {
      options.onStream?.({
        type: 'context_compacted',
        data: { sessionId: 'previous-thread' },
      });
      return {
        ...makeResponse('lost instruction', 'previous-thread'),
        sessionId: undefined,
      };
    });
    const options = makeRunOptions();
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction }));

    await new AgentRunner().run(undefined, 'original Phase 1 instruction', options);

    expect(recoverFromCompaction).toHaveBeenCalledWith('original Phase 1 instruction', {
      ...call.mock.calls[0]![1],
      onStream: expect.any(Function),
      sessionId: 'previous-thread',
    });
  });
});
