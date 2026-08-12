import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import {
  PHASE1_EMPTY_OUTPUT_ERROR,
  executeObservedPhase1Attempt,
  runPhase1WithEmptyRecovery,
  runSingleFreshPhase1Retry,
} from '../core/workflow/engine/phase1-empty-recovery.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';

function response(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: 'complete',
    timestamp: new Date('2026-07-29T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Phase 1 empty response recovery', () => {
  it('records a resolved thrown attempt as one failed completion and one failed usage', async () => {
    const onPhaseComplete = vi.fn();
    const recordFailure = vi.fn();
    await expect(executeObservedPhase1Attempt({
      enabled: false,
      runId: undefined,
      workflowName: 'review',
      eventStep: { kind: 'agent', name: 'reviewer', edit: false, rules: [] },
      spanStep: { kind: 'agent', name: 'reviewer', edit: false, rules: [] },
      iteration: 1,
      attempt: {
        sequence: 2,
        reason: 'initial',
        instruction: 'review',
        sessionId: 'session',
      },
      workflowStack: undefined,
      sanitizeText: undefined,
      providerInfo: { provider: 'mock', model: undefined },
      execute: async (_instruction, _sessionId, onPromptResolved) => {
        onPromptResolved({ systemPrompt: 'system', userPrompt: 'review' });
        throw new Error('provider failed');
      },
      onPhaseStart: vi.fn(),
      onPhaseComplete,
      recordFailure,
    })).rejects.toThrow('provider failed');

    expect(onPhaseComplete).toHaveBeenCalledOnce();
    expect(onPhaseComplete).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'execute',
      '',
      'error',
      'provider failed',
      expect.stringContaining(':1:2'),
      1,
    );
    expect(recordFailure).toHaveBeenCalledOnce();
  });

  it('publication retryは指定sequenceでfresh Phase 1を一度だけ実行する', async () => {
    const discardSession = vi.fn();
    const complete = vi.fn();
    const execute = vi.fn(async (attempt) => ({
      response: response({
        content: 'fresh review',
        sessionId: 'fresh-session',
      }),
      promptResolved: true,
      attempt,
    }));

    const result = await runSingleFreshPhase1Retry({
      stepName: 'architecture-review',
      sequence: 4,
      instruction: 'Review the implementation.',
      discardSession,
      execute,
      complete,
    });

    expect(discardSession).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      sequence: 4,
      reason: 'publication_retry_fresh',
      instruction: 'Review the implementation.',
      sessionId: undefined,
    });
    expect(complete).toHaveBeenCalledWith(
      result,
      expect.objectContaining({
        sequence: 4,
        reason: 'publication_retry_fresh',
      }),
    );
    expect(result.sessionId).toBe('fresh-session');
  });

  it('publication retryのfresh Phase 1が空なら再試行せず明示errorにする', async () => {
    const complete = vi.fn();
    const execute = vi.fn(async () => ({
      response: response({
        content: '   ',
        sessionId: 'discarded-session',
      }),
      promptResolved: true,
    }));

    const result = await runSingleFreshPhase1Retry({
      stepName: 'architecture-review',
      sequence: 4,
      instruction: 'Review the implementation.',
      discardSession: vi.fn(),
      execute,
      complete,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'error',
      content: '',
      error: PHASE1_EMPTY_OUTPUT_ERROR,
    });
    expect(result.sessionId).toBeUndefined();
    expect(complete).toHaveBeenCalledWith(
      result,
      expect.objectContaining({ reason: 'publication_retry_fresh' }),
    );
  });

  it.each([
    ['structured output', response({ content: '', structuredOutput: { result: 'ok' } })],
    ['blocked response', response({ status: 'blocked', content: '' })],
    ['rate limited response', response({ status: 'rate_limited', content: '', errorKind: 'rate_limit' })],
    ['provider stream parse error', response({
      status: 'error',
      content: '',
      error: 'Failed to parse item: invalid stdout line',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    })],
  ])('does not retry a %s', async (_label, terminalResponse) => {
    const execute = vi.fn().mockResolvedValue(terminalResponse);

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: true,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(terminalResponse.status);
    expect(result.response.structuredOutput).toEqual(terminalResponse.structuredOutput);
  });

  it('does not turn a provider error into an empty-output retry', async () => {
    const execute = vi.fn().mockResolvedValue(response({
      status: 'error',
      content: '',
      error: 'provider failed',
    }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: false,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.response).toMatchObject({
      status: 'error',
      error: 'provider failed',
    });
  });

  it('stops empty recovery when the continuation returns structured output', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(response({ content: '', sessionId: 'session-1' }))
      .mockResolvedValueOnce(response({
        content: '',
        sessionId: 'session-1',
        structuredOutput: { result: 'ok' },
      }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: false,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.response.structuredOutput).toEqual({ result: 'ok' });
  });

  it('restarts the original instruction fresh when continuation hits a provider error and provider recovery is enabled', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(response({ content: '', sessionId: 'session-1' }))
      .mockResolvedValueOnce(response({
        status: 'error',
        content: 'provider failed',
        error: 'provider failed',
        sessionId: 'session-1',
      }))
      .mockResolvedValueOnce(response({ content: 'complete fresh', sessionId: 'session-fresh' }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: true,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute.mock.calls.map(([attempt]) => [
      attempt.reason,
      attempt.instruction,
      attempt.sessionId,
    ])).toEqual([
      ['initial', 'original instruction', 'session-1'],
      ['empty_continuation', expect.stringContaining('Continue the review or work'), 'session-1'],
      ['provider_error_fresh', 'original instruction', undefined],
    ]);
    expect(result.response.content).toBe('complete fresh');
  });

  it('returns a continuation provider error without a fresh retry when provider recovery is disabled', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(response({ content: '', sessionId: 'session-1' }))
      .mockResolvedValueOnce(response({
        status: 'error',
        content: 'provider failed',
        error: 'provider failed',
        sessionId: 'session-1',
      }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: false,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute.mock.calls.map(([attempt]) => attempt.reason)).toEqual([
      'initial',
      'empty_continuation',
    ]);
    expect(result.response).toMatchObject({
      status: 'error',
      error: 'provider failed',
    });
  });

  it('skips fake continuation when an empty response has no effective session', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(response({ content: '', sessionId: undefined }))
      .mockResolvedValueOnce(response({ content: 'complete fresh', sessionId: 'session-fresh' }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: undefined,
      retryProviderErrorFresh: false,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute.mock.calls.map(([attempt]) => [
      attempt.reason,
      attempt.instruction,
      attempt.sessionId,
    ])).toEqual([
      ['initial', 'original instruction', undefined],
      ['empty_fresh', 'original instruction', undefined],
    ]);
    expect(result.response.content).toBe('complete fresh');
  });

  it('does not start a second fresh retry when provider recovery returns empty without a session', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(response({
        status: 'error',
        content: 'provider failed',
        error: 'provider failed',
        sessionId: 'session-1',
      }))
      .mockResolvedValueOnce(response({ content: '', sessionId: undefined }));

    const result = await runPhase1WithEmptyRecovery({
      instruction: 'original instruction',
      initialSessionId: 'session-1',
      retryProviderErrorFresh: true,
      execute,
      discardSession: vi.fn(),
      recordSupersededAttempt: vi.fn(),
    });

    expect(execute.mock.calls.map(([attempt]) => attempt.reason)).toEqual([
      'initial',
      'provider_error_fresh',
    ]);
    expect(result.response).toMatchObject({
      status: 'error',
      error: 'Phase 1 returned empty output',
    });
  });
});
