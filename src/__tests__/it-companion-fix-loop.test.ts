import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, CompanionFinding } from '../core/models/index.js';
import { runCompanionFixLoop } from '../core/workflow/companion/fix-loop.js';

function response(status: AgentResponse['status'], sessionId?: string): AgentResponse {
  return {
    persona: 'coder',
    status,
    content: `${status} response`,
    ...(sessionId === undefined ? {} : { sessionId }),
    timestamp: new Date('2026-08-14T00:00:00.000Z'),
  };
}

const finding: CompanionFinding = {
  companion: 'security-reviewer',
  reviewedAt: '2026-08-14T00:00:00.000Z',
  reviewedDigest: 'digest-1',
  severity: 'must_fix',
  file: 'src/a.ts',
  line: 1,
  finding: 'unsafe write',
};

describe('companion follow-up loop', () => {
  it('delivers each finding batch once at a turn boundary', async () => {
    const batches = [[finding], []];
    const completeReview = vi.fn(async () => ({ findings: batches.shift()! }));
    const executeFollowUp = vi.fn().mockResolvedValue(response('done', 'session-2'));

    const result = await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview,
      executeFollowUp,
    });

    expect(result.phaseResponse.sessionId).toBe('session-2');
    expect(result.followUpRounds).toBe(1);
    expect(executeFollowUp).toHaveBeenCalledOnce();
    expect(executeFollowUp.mock.calls[0]?.[0].instruction).toContain('digest-1');
    expect(completeReview).toHaveBeenNthCalledWith(2, expect.objectContaining({
      followUpRound: 1,
      implementerResponse: 'done response',
    }));
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'propagates a %s follow-up response with the latest session ID',
    async (status) => {
      const executeFollowUp = vi.fn()
        .mockResolvedValueOnce(response('done', 'session-2'))
        .mockResolvedValueOnce(response(status));
      const result = await runCompanionFixLoop({
        initialResponse: response('done', 'session-1'),
        phase1Options: {},
        completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
        executeFollowUp,
      });

      expect(result.phaseResponse.status).toBe(status);
      expect(result.phaseResponse.sessionId).toBe('session-2');
      expect(result.latestSessionId).toBe('session-2');
      expect(result.followUpRounds).toBe(2);
    },
  );

  it('propagates a thrown follow-up failure', async () => {
    const failure = new Error('follow-up failed');
    await expect(runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(failure),
    })).rejects.toBe(failure);
  });
});
