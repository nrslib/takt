import { describe, expect, it, vi } from 'vitest';
import {
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
} from '../agents/team-leader-decomposition-retry.js';

function invalidDecomposition(message: string): TeamLeaderDecompositionValidationError {
  return new TeamLeaderDecompositionValidationError([{
    code: 'decomposition.parts_invalid',
    path: '$.parts',
    message,
  }]);
}

describe('Team Leader decomposition retry', () => {
  it('retries a validation failure with bounded feedback and returns the next valid result', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(invalidDecomposition('findingIds must not be empty'))
      .mockResolvedValueOnce('valid');

    await expect(requestValidTeamLeaderDecomposition({ request })).resolves.toBe('valid');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, undefined);
    expect(request).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      maxAttempts: 3,
      issues: [{
        code: 'decomposition.parts_invalid',
        path: '$.parts',
        message: 'findingIds must not be empty',
      }],
    });
  });

  it('stops after three consecutive validation failures', async () => {
    const error = invalidDecomposition('still invalid');
    const request = vi.fn().mockRejectedValue(error);

    await expect(requestValidTeamLeaderDecomposition({ request })).rejects.toBe(error);

    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry provider or engine failures', async () => {
    const error = new Error('provider unavailable');
    const request = vi.fn().mockRejectedValue(error);

    await expect(requestValidTeamLeaderDecomposition({ request })).rejects.toBe(error);

    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects immediately when an in-flight request ignores cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const result = requestValidTeamLeaderDecomposition({
      abortSignal: controller.signal,
      request,
    });

    controller.abort(new Error('cancelled while waiting'));

    await expect(result).rejects.toThrow('cancelled while waiting');
    expect(request).toHaveBeenCalledOnce();
  });
});
