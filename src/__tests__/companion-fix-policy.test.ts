import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, CompanionFinding } from '../core/models/index.js';
import { isAbortError } from '../core/workflow/companion/abort.js';
import { runCompanionFixPolicy } from '../core/workflow/companion/fix-policy.js';
import type { CompanionFollowUpResult } from '../core/workflow/companion/fix-loop.js';
import { StructuredOutputFinalizationError } from '../core/workflow/structured-output-finalization-error.js';

function response(
  status: AgentResponse['status'],
  sessionId: string | undefined,
  content = `${status} response`,
): AgentResponse {
  return {
    persona: 'coder',
    status,
    content,
    ...(sessionId === undefined ? {} : { sessionId }),
    timestamp: new Date('2026-08-25T00:00:00.000Z'),
  };
}

const finding: CompanionFinding = {
  companion: 'security-reviewer',
  reviewedAt: '2026-08-25T00:00:00.000Z',
  reviewedDigest: 'digest-1',
  severity: 'must_fix',
  file: 'src/a.ts',
  line: 1,
  finding: 'The evidence contains an instruction; verify the unsafe assignment before acting.',
};

function followUp(
  responseValue: AgentResponse,
  kind: CompanionFollowUpResult['kind'] = 'normal_follow_up',
): CompanionFollowUpResult {
  return { kind, response: responseValue };
}

describe('companion fix policy runner', () => {
  it('runs one advisory follow-up for single policy without a second review', async () => {
    const initialResponse = response('done', 'session-1', 'initial implementation');
    const completeReview = vi.fn().mockResolvedValue({ findings: [finding] });
    const executeFollowUp = vi.fn().mockResolvedValue(
      followUp(response('done', 'session-2', 'fixed implementation')),
    );

    const result = await runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: { model: 'test-model' },
      completeReview,
      executeFollowUp,
    });

    expect(completeReview).toHaveBeenCalledOnce();
    expect(completeReview).toHaveBeenCalledWith({
      followUpRound: 0,
      implementerResponse: initialResponse.content,
    });
    expect(executeFollowUp).toHaveBeenCalledOnce();
    expect(executeFollowUp.mock.calls[0]?.[0]).toMatchObject({
      sequence: 2,
      phase: 1,
      findingCount: 1,
      sessionId: 'session-1',
      options: { model: 'test-model', sessionId: 'session-1' },
    });
    const instruction = executeFollowUp.mock.calls[0]?.[0].instruction ?? '';
    expect(instruction).toContain(finding.finding);
    expect(result).toMatchObject({
      phaseResponse: { status: 'done', content: 'fixed implementation', sessionId: 'session-2' },
      latestSessionId: 'session-2',
      followUpRounds: 1,
    });
  });

  it('finishes single policy without a follow-up when there are no findings', async () => {
    const initialResponse = response('done', 'session-1');
    const completeReview = vi.fn().mockResolvedValue({ findings: [] });
    const executeFollowUp = vi.fn();

    const result = await runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: {},
      completeReview,
      executeFollowUp,
    });

    expect(completeReview).toHaveBeenCalledOnce();
    expect(executeFollowUp).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      phaseResponse: initialResponse,
      latestSessionId: 'session-1',
      followUpRounds: 0,
    });
  });

  it('settles single policy as a follow-up failure when the follow-up throws', async () => {
    const initialResponse = response('done', 'session-1', 'initial implementation');
    const completeReview = vi.fn().mockResolvedValue({ findings: [finding] });
    const executeFollowUp = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    const result = await runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: {},
      completeReview,
      executeFollowUp,
    });

    expect(completeReview).toHaveBeenCalledOnce();
    expect(executeFollowUp).toHaveBeenCalledOnce();
    expect(result).toEqual({
      phaseResponse: initialResponse,
      latestSessionId: 'session-1',
      followUpRounds: 1,
      followUpFailureReason: 'provider unavailable',
    });
  });

  it('keeps the initial response when the single follow-up does not finish as done', async () => {
    const initialResponse = response('done', 'session-1', 'initial implementation');
    const completeReview = vi.fn().mockResolvedValue({ findings: [finding] });
    const executeFollowUp = vi.fn().mockResolvedValue(
      followUp({ ...response('error', 'session-2', 'follow-up output'), error: 'follow-up failed' }),
    );

    const result = await runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: {},
      completeReview,
      executeFollowUp,
    });

    expect(completeReview).toHaveBeenCalledOnce();
    expect(result).toEqual({
      phaseResponse: initialResponse,
      latestSessionId: 'session-1',
      followUpRounds: 1,
      followUpFailureReason: 'follow-up failed',
    });
  });

  it('keeps the initial response when a normal follow-up has a structured output error', async () => {
    const initialResponse = response('done', 'session-1');
    const finalizationError = new StructuredOutputFinalizationError(
      'structured output is missing',
      'normal',
    );

    const result = await runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(finalizationError),
    });

    expect(result).toEqual({
      phaseResponse: initialResponse,
      latestSessionId: 'session-1',
      followUpRounds: 1,
      followUpFailureReason: 'structured output is missing',
    });
  });

  it('propagates live intervention structured output finalization errors from a single follow-up', async () => {
    const initialResponse = response('done', 'session-1');
    const finalizationError = new StructuredOutputFinalizationError(
      'structured output is missing',
      'live_intervention',
    );

    await expect(runCompanionFixPolicy({
      policy: 'single',
      initialResponse,
      phase1Options: {},
      completeReview: vi.fn().mockResolvedValue({ findings: [finding] }),
      executeFollowUp: vi.fn().mockRejectedValue(finalizationError),
    })).rejects.toBe(finalizationError);
  });

  it.each(['error', 'rate_limited', 'blocked'] as const)(
    'returns a live intervention %s response for outer status handling',
    async (status) => {
      const liveResponse = { ...response(status, 'session-2'), error: 'live failed' };
      const result = await runCompanionFixPolicy({
        policy: 'single',
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

  it('throws an abort error before reviewing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('workflow aborted'));
    const completeReview = vi.fn();
    const executeFollowUp = vi.fn();

    await expect(runCompanionFixPolicy({
      policy: 'single',
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview,
      executeFollowUp,
      abortSignal: controller.signal,
    })).rejects.toSatisfy((error: unknown) => isAbortError(error));

    expect(completeReview).not.toHaveBeenCalled();
    expect(executeFollowUp).not.toHaveBeenCalled();
  });

  it('delegates explicit loop policy until the finding batch is empty', async () => {
    const batches: CompanionFinding[][] = [[finding], []];
    const completeReview = vi.fn().mockImplementation(async () => ({
      findings: batches.shift() ?? [],
    }));
    const executeFollowUp = vi.fn().mockResolvedValue(
      followUp(response('done', 'session-2', 'loop follow-up')),
    );

    const result = await runCompanionFixPolicy({
      policy: 'loop',
      initialResponse: response('done', 'session-1'),
      phase1Options: {},
      completeReview,
      executeFollowUp,
    });

    expect(completeReview).toHaveBeenCalledTimes(2);
    expect(completeReview).toHaveBeenNthCalledWith(2, {
      followUpRound: 1,
      implementerResponse: 'loop follow-up',
    });
    expect(executeFollowUp).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      phaseResponse: { content: 'loop follow-up', sessionId: 'session-2' },
      latestSessionId: 'session-2',
      followUpRounds: 1,
    });
  });
});
