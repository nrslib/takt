import { describe, expect, it, vi } from 'vitest';
import {
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
} from '../agents/team-leader-decomposition-regeneration.js';

function invalidDecomposition(message: string): TeamLeaderDecompositionValidationError {
  return new TeamLeaderDecompositionValidationError(
    'decomposition.parts_invalid',
    '$.parts',
    new Error(message),
  );
}

describe('Team Leader decomposition regeneration', () => {
  it('regenerates after semantic validation failure and passes bounded diagnostics', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(invalidDecomposition('x'.repeat(3_000)))
      .mockResolvedValueOnce('valid');

    await expect(requestValidTeamLeaderDecomposition({ request })).resolves.toBe('valid');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, undefined);
    expect(request).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      maxAttempts: 3,
      diagnostic: {
        code: 'decomposition.parts_invalid',
        path: '$.parts',
        message: `${'x'.repeat(1_999)}…`,
      },
    });
  });

  it('stops after three consecutive semantic validation failures', async () => {
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

  it('does not invoke the request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const request = vi.fn();

    await expect(requestValidTeamLeaderDecomposition({
      abortSignal: controller.signal,
      request,
    })).rejects.toThrow('cancelled before start');

    expect(request).not.toHaveBeenCalled();
  });
});
