import { describe, expect, it, vi } from 'vitest';
import { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';

const snapshot = {
  digest: 'digest-1',
  changedLines: 1,
  content: '+change',
  changedFiles: ['src/a.ts'],
  fileFingerprints: { 'src/a.ts': 'file-1' },
  hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
  omittedBytes: 0,
  truncated: false,
};

function request(reason: 'quiet' | 'completion' = 'quiet') {
  return { companionName: 'reviewer', snapshot, reason, observedGeneration: 1 } as const;
}

describe('companion review queue', () => {
  it('drains running and queued rounds without aborting them', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const runReview = vi.fn(async (input: { reason: string; signal: AbortSignal }) => {
      order.push(`start:${input.reason}`);
      if (input.reason === 'quiet') await first;
      expect(input.signal.aborted).toBe(false);
      order.push(`end:${input.reason}`);
    });
    const queue = new CompanionReviewQueue({
      runReview,
      refreshRetryRequest: vi.fn(),
    });

    const live = queue.enqueue(request());
    const completion = queue.complete({
      companionName: 'reviewer',
      snapshot,
      observedGeneration: 1,
    });
    const drained = queue.drain('reviewer');
    await Promise.resolve();
    expect(order).toEqual(['start:quiet']);
    releaseFirst();
    await Promise.all([live, completion, drained]);

    expect(order).toEqual([
      'start:quiet',
      'end:quiet',
      'start:completion',
      'end:completion',
    ]);
  });

  it('requeues one failed round as a whole with a refreshed snapshot', async () => {
    const runReview = vi.fn()
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce(undefined);
    const refreshRetryRequest = vi.fn(async (original) => ({
      ...original,
      snapshot: { ...snapshot, digest: 'digest-2' },
      observedGeneration: 2,
    }));
    const queue = new CompanionReviewQueue({ runReview, refreshRetryRequest });

    await expect(queue.enqueue(request())).resolves.toBeUndefined();
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(refreshRetryRequest).toHaveBeenCalledOnce();
    expect(runReview.mock.calls[1]?.[0]).toMatchObject({
      snapshot: { digest: 'digest-2' },
      observedGeneration: 2,
    });
  });
});
