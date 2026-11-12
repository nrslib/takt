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
