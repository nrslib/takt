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

  it('limits TAKT recovery calls to three even when each recovery uses a tool', async () => {
    const onStream = vi.fn();
    const call = vi.fn<ProviderAgent['call']>(async (_instruction, options) => {
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: 'unresolved', sessionId: 'current-thread', success: true } });
      return makeResponse('unresolved', 'current-thread');
    });
    const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(async (_instruction, options) => {
      options.onStream?.({ type: 'tool_use', data: { tool: 'Read', input: {}, id: 'read' } });
      options.onStream?.({ type: 'context_compacted', data: { sessionId: 'current-thread' } });
      options.onStream?.({ type: 'result', data: { result: 'unresolved', sessionId: 'current-thread', success: true } });
      return makeResponse('unresolved', 'current-thread');
    });
    const assessCompactedResponse = vi.fn<NonNullable<ProviderAgent['assessCompactedResponse']>>(
      async () => ({ decision: 'needs_recovery' }),
    );
    getProviderMock.mockReturnValue(makeProvider({ call, recoverFromCompaction, assessCompactedResponse }));

    const result = await new AgentRunner().run('coding-reviewer', 'Review the current change', makeRunOptions({ onStream }));

    expect(result).toMatchObject({ status: 'error', failureCategory: 'provider_error' });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(3);
    expect(assessCompactedResponse).toHaveBeenCalledTimes(4);
    expect(onStream.mock.calls.filter(([event]) => event.type === 'result')).toEqual([[
      expect.objectContaining({ type: 'result', data: expect.objectContaining({ success: false, sessionId: 'current-thread' }) }),
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
