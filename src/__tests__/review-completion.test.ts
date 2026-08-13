import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import {
  buildReviewCompletionJudgePrompt,
  buildReviewCompletionOutputSchema,
  parseReviewCompletionDecision,
  runReviewCompletionEpisode,
} from '../core/workflow/review-completion.js';

function response(content: string, sessionId = 'review-session'): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content,
    sessionId,
    timestamp: new Date(0),
  };
}

describe('review completion episode', () => {
  it('uses the actual reviewer instruction as the sole scope authority', () => {
    const prompt = buildReviewCompletionJudgePrompt({
      language: 'en',
      task: 'review the change',
      reviewerInstruction: 'Review only accepted-family regressions. Do not explore new families.',
      reviewScope: { changedPaths: ['src/changed.ts'] },
      evidence: {
        status: 'collected',
        files: [],
        references: [],
        claimedPaths: [],
        priorGapPaths: [],
        omissions: [],
      },
      reviewResponse: 'No regression found.',
    });

    expect(prompt.instruction).toContain('Review only accepted-family regressions');
    expect(prompt.systemPrompt).toContain('sole source of scope and authority');
    expect(prompt.instruction).not.toContain('review_mode');
  });

  it('keeps the reviewer session and original scope for retries', async () => {
    const executeRetry = vi.fn(async ({ sessionId }: { sessionId: string | undefined }) => (
      response('retry', sessionId)
    ));
    const judge = vi.fn()
      .mockResolvedValueOnce({
        complete: false,
        reason: 'missing consumer',
        missingObligations: [{
          kind: 'changed_target_gap',
          contractFamily: 'config',
          path: 'consumer.ts',
          reason: 'not inspected',
        }],
      })
      .mockResolvedValueOnce({ complete: true, reason: 'closed', missingObligations: [] });

    const result = await runReviewCompletionEpisode({
      config: {
        minRetry: 0,
        maxRetry: 4,
        retryInstruction: 'close only the supplied gaps',
      },
      originalInstruction: 'review',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry,
      judge,
      isAbort: () => false,
    });

    expect(result.attempts).toBe(2);
    expect(executeRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'review-session',
      instruction: expect.stringContaining('close only the supplied gaps'),
    }));
    expect(executeRetry.mock.calls[0]?.[0].instruction).toContain('consumer.ts');
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.diagnostic).toBeUndefined();
  });

  it('stops immediately when the judge confirms completeness', async () => {
    const initial = response('complete review');
    const executeRetry = vi.fn();
    const result = await runReviewCompletionEpisode({
      config: { minRetry: 0, maxRetry: 4, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: initial,
      initialSessionId: initial.sessionId,
      executeRetry,
      judge: vi.fn().mockResolvedValue({
        complete: true,
        reason: 'complete',
        missingObligations: [],
      }),
      isAbort: () => false,
    });

    expect(result).toMatchObject({
      attempts: 1,
      response: initial,
    });
    expect(result.diagnostic).toBeUndefined();
    expect(executeRetry).not.toHaveBeenCalled();
  });

  it('returns a Phase 2 diagnostic without modifying the latest reviewer response', async () => {
    const latest = response('authoritative reviewer report');
    const executeRetry = vi.fn();
    const result = await runReviewCompletionEpisode({
      config: {
        minRetry: 0,
        maxRetry: 0,
        retryInstruction: 'retry',
      },
      originalInstruction: 'review',
      initialResponse: latest,
      initialSessionId: latest.sessionId,
      executeRetry,
      judge: vi.fn().mockRejectedValue(new Error('judge unavailable')),
      isAbort: () => false,
    });

    expect(result.response).toBe(latest);
    expect(result.diagnostic?.kind).toBe('judge_unavailable');
    expect(result.reviewerSessionId).toBe(latest.sessionId);
    expect(executeRetry).not.toHaveBeenCalled();
  });

  it('executes the configured minimum retry even when the initial review is complete', async () => {
    const executeRetry = vi.fn(async () => response('mandatory retry', 'retry-session'));
    const judge = vi.fn().mockResolvedValue({
      complete: true,
      reason: 'complete',
      missingObligations: [],
    });

    const result = await runReviewCompletionEpisode({
      config: { minRetry: 1, maxRetry: 2, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry,
      judge,
      isAbort: () => false,
    });

    expect(executeRetry).toHaveBeenCalledOnce();
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ attempts: 2, response: { content: 'mandatory retry' } });
    expect(result.diagnostic).toBeUndefined();
  });

  it('reports max_retry_reached when the mandatory final retry remains incomplete', async () => {
    const judge = vi.fn()
      .mockResolvedValueOnce({ complete: true, reason: 'initially complete', missingObligations: [] })
      .mockResolvedValueOnce({
        complete: false,
        reason: 'final retry introduced a gap',
        missingObligations: [{
          kind: 'remediation_regression',
          contractFamily: 'review-completion',
          path: 'consumer.ts',
          reason: 'regression remains',
        }],
      });

    const result = await runReviewCompletionEpisode({
      config: { minRetry: 1, maxRetry: 1, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry: vi.fn(async () => response('mandatory retry', 'retry-session')),
      judge,
      isAbort: () => false,
    });

    expect(result.attempts).toBe(2);
    expect(result.diagnostic?.kind).toBe('max_retry_reached');
    expect(result.diagnostic?.retriesUsed).toBe(1);
    expect(result.diagnostic?.missingObligations).toEqual([{
      kind: 'remediation_regression',
      contractFamily: 'review-completion',
      path: 'consumer.ts',
      reason: 'regression remains',
    }]);
  });

  it('stops at the internal ceiling when every completeness decision remains incomplete', async () => {
    const missingObligation = {
      kind: 'family_lifecycle_gap' as const,
      contractFamily: 'config',
      path: 'consumer.ts',
      reason: 'unvisited',
    };
    const executeRetry = vi.fn(async ({ attemptIndex }: { attemptIndex: number }) => (
      response(`retry-${attemptIndex}`, `retry-session-${attemptIndex}`)
    ));
    const judge = vi.fn().mockResolvedValue({
      complete: false,
      reason: 'gap remains',
      missingObligations: [missingObligation],
    });

    const result = await runReviewCompletionEpisode({
      config: { minRetry: 0, maxRetry: 4, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry,
      judge,
      isAbort: () => false,
    });

    expect(executeRetry).toHaveBeenCalledTimes(4);
    expect(judge).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      attempts: 5,
      diagnostic: {
        kind: 'max_retry_reached',
        retriesUsed: 4,
        missingObligations: [missingObligation],
      },
    });
  });

  it('honors an explicit retry ceiling above the internal ceiling', async () => {
    const missingObligation = {
      kind: 'changed_target_gap' as const,
      contractFamily: 'config',
      path: 'consumer.ts',
      reason: 'unvisited',
    };
    const executeRetry = vi.fn(async ({ attemptIndex }: { attemptIndex: number }) => (
      response(`retry-${attemptIndex}`, `retry-session-${attemptIndex}`)
    ));
    const judge = vi.fn().mockResolvedValue({
      complete: false,
      reason: 'gap remains',
      missingObligations: [missingObligation],
    });

    const result = await runReviewCompletionEpisode({
      config: { minRetry: 0, maxRetry: 8, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry,
      judge,
      isAbort: () => false,
    });

    expect(executeRetry).toHaveBeenCalledTimes(8);
    expect(judge).toHaveBeenCalledTimes(9);
    expect(result).toMatchObject({
      attempts: 9,
      diagnostic: {
        kind: 'max_retry_reached',
        retriesUsed: 8,
        missingObligations: [missingObligation],
      },
    });
  });

  it('uses one schema because the actual reviewer instruction defines scope', () => {
    const schema = buildReviewCompletionOutputSchema();
    expect(JSON.stringify(schema)).toContain('required_consumer_migration');
    expect(parseReviewCompletionDecision({
      complete: true,
      reason: 'complete within the reviewer instruction',
      missing_obligations: [],
    })).toMatchObject({ complete: true });
  });

  it.each([
    ['non-done', async () => ({ ...response('failed'), status: 'error' as const, error: 'retry failed' })],
    ['throw', async () => { throw new Error('retry threw'); }],
  ])('keeps the latest valid response when a reviewer retry %s', async (_name, executeRetry) => {
    const latest = response('authoritative reviewer report', 'stable-session');
    const result = await runReviewCompletionEpisode({
      config: { minRetry: 0, maxRetry: 1, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialResponse: latest,
      initialSessionId: latest.sessionId,
      executeRetry,
      judge: vi.fn().mockResolvedValue({
        complete: false,
        reason: 'gap',
        missingObligations: [{
          kind: 'family_lifecycle_gap',
          contractFamily: 'config',
          path: 'consumer.ts',
          reason: 'unvisited',
        }],
      }),
      isAbort: () => false,
    });

    expect(result.response).toBe(latest);
    expect(result.reviewerSessionId).toBe('stable-session');
    expect(result.diagnostic?.kind).toBe('reviewer_retry_failed');
  });
});
