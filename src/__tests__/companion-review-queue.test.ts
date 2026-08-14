import { describe, expect, it, vi } from 'vitest';
import {
  CompanionReviewQueue,
  type CompanionReviewRequest,
} from '../core/workflow/companion/review-queue.js';

function snapshot(digest: string) {
  return {
    digest,
    changedLines: 1,
    content: digest,
    changedFiles: ['src/a.ts'],
    fileFingerprints: { 'src/a.ts': digest },
    hunkFingerprints: { 'src/a.ts:1-1': digest },
    omittedBytes: 0,
    truncated: false,
  };
}

function request(digest: string, reason: 'quiet' | 'forced' | 'completion' = 'quiet') {
  return {
    companionName: 'security-reviewer',
    snapshot: snapshot(digest),
    reason,
    observedGeneration: 1,
  };
}

const keepRetryRequest = async (
  current: CompanionReviewRequest,
): Promise<CompanionReviewRequest> => current;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CT-COMP-05 companion review queue lifecycle', () => {
  it('should serialize rounds for one companion and batch changes into the next round', async () => {
    const first = deferred<void>();
    const starts: string[] = [];
    const coalesced: unknown[] = [];
    const runReview = vi.fn(async (request: { companionName: string; snapshot: { digest: string } }) => {
      starts.push(request.snapshot.digest);
      if (request.snapshot.digest === 'diff-1') await first.promise;
    });
    const queue = new CompanionReviewQueue({
      runReview,
      refreshRetryRequest: keepRetryRequest,
      onCoalesced: (event) => coalesced.push(event),
    });

    const round1 = queue.enqueue(request('diff-1'));
    const round2 = queue.enqueue(request('diff-2'));
    const round3 = queue.enqueue(request('diff-3'));
    await Promise.resolve();
    expect(starts).toEqual(['diff-1']);
    first.resolve();
    await Promise.all([round1, round2, round3]);

    expect(starts).toEqual(['diff-1', 'diff-3']);
    expect(coalesced).toEqual([{
      companionName: 'security-reviewer',
      replaced: {
        trigger: 'quiet',
        digest: 'diff-2',
        changedLines: 1,
        observedGeneration: 1,
      },
      replacement: {
        trigger: 'quiet',
        digest: 'diff-3',
        changedLines: 1,
        observedGeneration: 1,
      },
    }]);
  });

  it('should allow different companions to review concurrently', async () => {
    const release = deferred<void>();
    const active = new Set<string>();
    let maximumConcurrency = 0;
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ companionName }: { companionName: string }) => {
        active.add(companionName);
        maximumConcurrency = Math.max(maximumConcurrency, active.size);
        await release.promise;
        active.delete(companionName);
      }),
      refreshRetryRequest: keepRetryRequest,
    });

    const security = queue.enqueue(request('diff-a'));
    const design = queue.enqueue({ ...request('diff-a'), companionName: 'design-reviewer' });
    await Promise.resolve();
    expect(maximumConcurrency).toBe(2);
    release.resolve();
    await Promise.all([security, design]);
  });

  it('should abort a running WIP review before starting the completion review', async () => {
    const order: string[] = [];
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ reason, signal }: { reason: string; signal: AbortSignal }) => {
        order.push(`start:${reason}`);
        if (reason === 'completion') return;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('abort:wip');
            reject(new Error('abort cleanup failed'));
          }, { once: true });
        });
      }),
      refreshRetryRequest: keepRetryRequest,
    });

    const wip = queue.enqueue(request('wip'));
    const wipRejected = expect(wip).rejects.toThrow('abort cleanup failed');
    await Promise.resolve();
    await queue.complete({ ...request('final', 'completion') });
    await wipRejected;

    expect(order).toEqual(['start:quiet', 'abort:wip', 'start:completion']);
  });

  it('should keep failed waiters pending until a single retry succeeds', async () => {
    const refreshStarted = deferred<void>();
    const releaseRefresh = deferred<void>();
    const starts: string[] = [];
    let attempts = 0;
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ snapshot: current }: { snapshot: { digest: string } }) => {
        starts.push(current.digest);
        if (attempts++ === 0) throw new Error('review failed');
      }),
      refreshRetryRequest: async (current) => {
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return current;
      },
    });

    const failed = queue.enqueue(request('fail'));
    let settled = false;
    failed.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await refreshStarted.promise;
    expect(settled).toBe(false);

    releaseRefresh.resolve();
    await expect(failed).resolves.toBeUndefined();
    expect(starts).toEqual(['fail', 'fail']);
  });

  it('should run a pending newer batch before retrying the failed batch', async () => {
    const newerStarted = deferred<void>();
    const releaseNewer = deferred<void>();
    const starts: string[] = [];
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ snapshot: current }: { snapshot: { digest: string } }) => {
        starts.push(current.digest);
        if (current.digest === 'failed') {
          if (starts.length === 1) throw new Error('review failed');
          return;
        }
        newerStarted.resolve();
        await releaseNewer.promise;
      }),
      refreshRetryRequest: keepRetryRequest,
    });

    const failed = queue.enqueue(request('failed'));
    const newer = queue.enqueue(request('newer', 'forced'));
    let failedSettled = false;
    failed.then(
      () => { failedSettled = true; },
      () => { failedSettled = true; },
    );
    await newerStarted.promise;
    expect(starts).toEqual(['failed', 'newer']);
    expect(failedSettled).toBe(false);

    releaseNewer.resolve();
    await Promise.all([
      expect(newer).resolves.toBeUndefined(),
      expect(failed).resolves.toBeUndefined(),
    ]);
    expect(starts).toEqual(['failed', 'newer', 'failed']);
  });

  it('should refresh the snapshot and generation immediately before retrying', async () => {
    const starts: Array<{
      companionName: string;
      reason: CompanionReviewRequest['reason'];
      digest: string;
      observedGeneration: number;
    }> = [];
    const refreshRetryRequest = vi.fn(async (current: CompanionReviewRequest) => ({
      ...current,
      snapshot: snapshot('latest'),
      observedGeneration: 7,
    }));
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({
        companionName,
        reason,
        snapshot: current,
        observedGeneration,
      }: CompanionReviewRequest) => {
        starts.push({
          companionName,
          reason,
          digest: current.digest,
          observedGeneration,
        });
        if (current.digest === 'stale') throw new Error('review failed');
      }),
      refreshRetryRequest,
    });

    await expect(queue.enqueue(request('stale'))).resolves.toBeUndefined();

    expect(refreshRetryRequest).toHaveBeenCalledTimes(1);
    expect(refreshRetryRequest).toHaveBeenCalledWith(request('stale'));
    expect(starts).toEqual([
      {
        companionName: 'security-reviewer',
        reason: 'quiet',
        digest: 'stale',
        observedGeneration: 1,
      },
      {
        companionName: 'security-reviewer',
        reason: 'quiet',
        digest: 'latest',
        observedGeneration: 7,
      },
    ]);
  });

  it('should reject after one retry and keep later batches alive', async () => {
    const starts: string[] = [];
    let failures = 0;
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ snapshot: current }: { snapshot: { digest: string } }) => {
        starts.push(current.digest);
        if (current.digest === 'failed') {
          failures += 1;
          throw new Error(`review failed ${failures}`);
        }
      }),
      refreshRetryRequest: keepRetryRequest,
    });

    const failed = queue.enqueue(request('failed'));
    const later = queue.enqueue(request('later', 'forced'));

    await expect(failed).rejects.toThrow('review failed 2');
    await expect(later).resolves.toBeUndefined();
    expect(failures).toBe(2);
    expect(starts).toEqual(['failed', 'later', 'failed']);
  });

  it('should abort the active review and reject pending work when stopped', async () => {
    const started = deferred<void>();
    let activeSignal: AbortSignal | undefined;
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        activeSignal = signal;
        started.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ));
      }),
      refreshRetryRequest: keepRetryRequest,
    });
    const active = queue.enqueue(request('active'));
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    const pending = queue.enqueue(request('pending', 'forced'));
    const pendingRejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    queue.stop(new Error('shutdown'));

    await Promise.all([activeRejected, pendingRejected]);
    expect(activeSignal?.aborted).toBe(true);
    expect(() => queue.enqueue(request('later'))).toThrow(/Abort/);
  });

  it('should settle only after active abort cleanup and reject pending waiters immediately', async () => {
    const started = deferred<void>();
    const releaseCleanup = deferred<void>();
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener(
          'abort',
          async () => {
            await releaseCleanup.promise;
            reject(new Error('abort cleanup failed'));
          },
          { once: true },
        ));
      }),
      refreshRetryRequest: keepRetryRequest,
    });
    const active = queue.enqueue(request('active'));
    const activeRejected = expect(active).rejects.toThrow('abort cleanup failed');
    await started.promise;
    const pending = queue.enqueue(request('pending', 'forced'));
    const pendingRejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    let settled = false;

    const settlement = queue.settle('security-reviewer').then(() => { settled = true; });
    await pendingRejected;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup.resolve();

    await Promise.all([activeRejected, settlement]);
    expect(settled).toBe(true);
    await expect(queue.settle('security-reviewer')).resolves.toBeUndefined();
  });
});
