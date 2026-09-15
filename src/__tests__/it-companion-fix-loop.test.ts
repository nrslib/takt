import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, CompanionFinding } from '../core/models/index.js';
import {
  runCompanionFixLoop,
  type CompanionFollowUpResult,
} from '../core/workflow/companion/fix-loop.js';
import { StructuredOutputFinalizationError } from '../core/workflow/structured-output-finalization-error.js';

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

function followUp(
  responseValue: AgentResponse,
  kind: CompanionFollowUpResult['kind'] = 'normal_follow_up',
): CompanionFollowUpResult {
  return { kind, response: responseValue };
}

describe('companion follow-up loop', () => {
  it('delivers each finding batch once at a turn boundary', async () => {
    const batches = [[finding], []];
    const completeReview = vi.fn(async () => ({ findings: batches.shift()! }));
    const executeFollowUp = vi.fn().mockResolvedValue(followUp(response('done', 'session-2')));

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
    'stops after a %s follow-up response and returns the latest success',
    async (status) => {
      const executeFollowUp = vi.fn()
        .mockResolvedValueOnce({
          kind: 'normal_follow_up',
          response: {
            ...response('done', 'session-2'),
            content: 'first follow-up succeeded',
          },
        })
        .mockResolvedValueOnce(followUp(response(status)));
      const result = await runCompanionFixLoop({
        initialResponse: response('done', 'session-1'),
        phase1Options: {},
        completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
        executeFollowUp,
      });

      expect(result.phaseResponse).toMatchObject({
        status: 'done',
        content: 'first follow-up succeeded',
        sessionId: 'session-2',
      });
      expect(result.phaseResponse.sessionId).toBe('session-2');
      expect(result.latestSessionId).toBe('session-2');
      expect(result.followUpRounds).toBe(2);
      expect(result.followUpFailureReason).toBe(`${status} response`);
      expect(executeFollowUp).toHaveBeenCalledTimes(2);
    },
  );

  it('stops after a thrown follow-up failure and sanitizes the diagnostic', async () => {
    const result = await runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(
        new Error('Provider failed: token=secret at /private/project/file.ts'),
      ),
    });

    expect(result.phaseResponse).toMatchObject({ status: 'done', sessionId: 'session-1' });
    expect(result.latestSessionId).toBe('session-1');
    expect(result.followUpRounds).toBe(1);
    expect(result.followUpFailureReason).toBe('Provider failed: token=[REDACTED] at [path]');
  });

  it('keeps the latest response when a normal loop follow-up has a structured output error', async () => {
    const initialResponse = response('done', 'session-1');
    const finalizationError = new StructuredOutputFinalizationError(
      'structured output is invalid',
      'normal',
    );

    const result = await runCompanionFixLoop({
      initialResponse,
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(finalizationError),
    });

    expect(result).toEqual({
      phaseResponse: initialResponse,
      latestSessionId: 'session-1',
      followUpRounds: 1,
      followUpFailureReason: 'structured output is invalid',
    });
  });

  it('propagates live intervention structured output finalization errors from a loop follow-up', async () => {
    const finalizationError = new StructuredOutputFinalizationError(
      'structured output is invalid',
      'live_intervention',
    );

    await expect(runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(finalizationError),
    })).rejects.toBe(finalizationError);
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'returns a live intervention %s response instead of the latest success',
    async (status) => {
      const liveResponse = { ...response(status, 'session-2'), error: 'live failed' };
      const result = await runCompanionFixLoop({
        initialResponse: response('done', 'session-1'),
        phase1Options: {},
        completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
        executeFollowUp: vi.fn().mockResolvedValue(
          followUp(liveResponse, 'live_intervention'),
        ),
      });

      expect(result.phaseResponse).toBe(liveResponse);
      expect(result.phaseResponse.status).toBe(status);
      expect(result.followUpFailureReason).toBe('live failed');
    },
  );

  it('propagates AbortSignal cancellation during a follow-up', async () => {
    const controller = new AbortController();

    await expect(runCompanionFixLoop({
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockImplementation(async () => {
        controller.abort(new Error('cancelled by user'));
        throw new Error('follow-up stopped');
      }),
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled by user' });
  });
});
