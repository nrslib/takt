import { describe, expect, it, vi } from 'vitest';
import { FindingContractTeamLeaderDecisionValidationError } from '../core/workflow/team-leader-finding-contract-decision.js';
import { requestValidFindingContractDecision } from '../core/workflow/engine/team-leader-finding-contract-decision-retry.js';

describe('Finding Contract Team Leader decision retry', () => {
  it('regenerates only the rejected decision and passes validation feedback to the next attempt', async () => {
    const validationError = new FindingContractTeamLeaderDecisionValidationError(
      'continue decision must not include fixCoverage',
    );
    const request = vi.fn()
      .mockRejectedValueOnce(validationError)
      .mockResolvedValueOnce({ decision: 'complete' });

    const result = await requestValidFindingContractDecision({
      request,
      validate: vi.fn(),
    });

    expect(result).toEqual({ decision: 'complete' });
    expect(request).toHaveBeenNthCalledWith(1, undefined);
    expect(request).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      maxAttempts: 3,
      validationError: validationError.message,
    });
  });

  it('throws the third validation error without wrapping it', async () => {
    const errors = [1, 2, 3].map((attempt) => (
      new FindingContractTeamLeaderDecisionValidationError(`invalid attempt ${attempt}`)
    ));
    const request = vi.fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2]);

    await expect(requestValidFindingContractDecision({
      request,
      validate: vi.fn(),
    })).rejects.toBe(errors[2]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry provider or engine errors', async () => {
    const providerError = new Error('provider unavailable');
    const request = vi.fn().mockRejectedValue(providerError);

    await expect(requestValidFindingContractDecision({
      request,
      validate: vi.fn(),
    })).rejects.toBe(providerError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops before another attempt when the run is aborted', async () => {
    const controller = new AbortController();
    const abortReason = new Error('user stopped the run');
    const request = vi.fn(async () => {
      controller.abort(abortReason);
      throw new FindingContractTeamLeaderDecisionValidationError('invalid decision');
    });

    await expect(requestValidFindingContractDecision({
      abortSignal: controller.signal,
      request,
      validate: vi.fn(),
    })).rejects.toBe(abortReason);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('regenerates when completion evidence validation rejects an otherwise parsed decision', async () => {
    const invalidEvidence = new FindingContractTeamLeaderDecisionValidationError(
      'fixCoverage has no supporting part claim',
    );
    const request = vi.fn()
      .mockResolvedValueOnce({ decision: 'complete', validEvidence: false })
      .mockResolvedValueOnce({ decision: 'complete', validEvidence: true });

    const result = await requestValidFindingContractDecision({
      request,
      validate: (decision) => {
        if (!decision.validEvidence) throw invalidEvidence;
      },
    });

    expect(result.validEvidence).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
