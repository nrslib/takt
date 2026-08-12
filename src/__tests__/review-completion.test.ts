import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/types.js';
import {
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
  it('keeps the configured review mode for same-session retries', async () => {
    const executeRetry = vi.fn(async ({ sessionId }: { sessionId: string | undefined }) => (
      response('retry', sessionId)
    ));
    const judge = vi.fn()
      .mockResolvedValueOnce({
        complete: false,
        reason: 'missing consumer',
        missingObligations: [{
          kind: 'initial_changed_target_gap',
          contractFamily: 'config',
          path: 'consumer.ts',
          reason: 'not inspected',
        }],
      })
      .mockResolvedValueOnce({ complete: true, reason: 'closed', missingObligations: [] });

    const result = await runReviewCompletionEpisode({
      config: {
        mode: 'initial',
        minRetry: 0,
        maxRetry: 1,
        retryInstruction: 'retry {review_mode}',
      },
      originalInstruction: 'review',
      initialMode: 'initial',
      initialResponse: response('initial'),
      initialSessionId: 'review-session',
      executeRetry,
      judge,
      isAbort: () => false,
    });

    expect(result.attempts).toBe(2);
    expect(executeRetry).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'initial',
      sessionId: 'review-session',
    }));
    expect(judge.mock.calls.map((call) => call[2])).toEqual(['initial', 'initial']);
  });

  it('returns a Phase 2 diagnostic without modifying the latest reviewer response', async () => {
    const latest = response('authoritative reviewer report');
    const result = await runReviewCompletionEpisode({
      config: {
        mode: 'follow_up',
        minRetry: 0,
        maxRetry: 0,
        retryInstruction: 'retry',
      },
      originalInstruction: 'review',
      initialMode: 'follow_up',
      initialResponse: latest,
      initialSessionId: latest.sessionId,
      executeRetry: vi.fn(),
      judge: vi.fn().mockRejectedValue(new Error('judge unavailable')),
      isAbort: () => false,
    });

    expect(result.response).toBe(latest);
    expect(result.diagnostic?.kind).toBe('judge_unavailable');
  });

  it('limits follow_up gaps to the four authorization bases', () => {
    const schema = buildReviewCompletionOutputSchema('follow_up');
    expect(JSON.stringify(schema)).not.toContain('initial_changed_target_gap');
    expect(() => parseReviewCompletionDecision({
      complete: false,
      reason: 'invalid gap',
      missing_obligations: [{
        kind: 'family_lifecycle_gap',
        contract_family: 'runtime',
        path: 'consumer.ts',
        reason: 'missing',
      }],
    }, 'follow_up')).toThrow(/kind/);
  });

  it.each([
    ['non-done', async () => ({ ...response('failed'), status: 'error' as const, error: 'retry failed' })],
    ['throw', async () => { throw new Error('retry threw'); }],
  ])('keeps the latest valid response when a reviewer retry %s', async (_name, executeRetry) => {
    const latest = response('authoritative reviewer report', 'stable-session');
    const result = await runReviewCompletionEpisode({
      config: { mode: 'initial', minRetry: 0, maxRetry: 1, retryInstruction: 'retry' },
      originalInstruction: 'review',
      initialMode: 'initial',
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
