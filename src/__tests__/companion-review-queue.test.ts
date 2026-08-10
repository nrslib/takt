import { describe, expect, it, vi } from 'vitest';
import { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CT-COMP-05 companion review queue lifecycle', () => {
  it('should serialize rounds for one companion and batch changes into the next round', async () => {
    const first = deferred<void>();
    const starts: string[] = [];
    const runReview = vi.fn(async (request: { companionName: string; snapshot: { digest: string } }) => {
      starts.push(request.snapshot.digest);
      if (request.snapshot.digest === 'diff-1') await first.promise;
    });
    const queue = new CompanionReviewQueue({ runReview });

    const round1 = queue.enqueue(request('diff-1'));
    const round2 = queue.enqueue(request('diff-2'));
    const round3 = queue.enqueue(request('diff-3'));
    await Promise.resolve();
    expect(starts).toEqual(['diff-1']);
    first.resolve();
    await Promise.all([round1, round2, round3]);

    expect(starts).toEqual(['diff-1', 'diff-3']);
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
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }),
    });

    const wip = queue.enqueue(request('wip'));
    const wipRejected = expect(wip).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    await queue.complete({ ...request('final', 'completion') });
    await wipRejected;

    expect(order).toEqual(['start:quiet', 'abort:wip', 'start:completion']);
  });

  it('should reject pending waiters and allow a later round after a non-abort failure', async () => {
    const runReview = vi.fn(async ({ snapshot: current }: { snapshot: { digest: string } }) => {
      if (current.digest === 'fail') throw new Error('review failed');
    });
    const queue = new CompanionReviewQueue({ runReview });

    const failed = queue.enqueue(request('fail'));
    const pending = queue.enqueue(request('pending'));
    await expect(failed).rejects.toThrow('review failed');
    await expect(pending).rejects.toThrow('review failed');
    await expect(queue.enqueue(request('recovered'))).resolves.toBeUndefined();
  });

  it('should keep completion and a settlement-time enqueue serialized after a failure', async () => {
    const failing = deferred<void>();
    const completion = deferred<void>();
    const starts: string[] = [];
    let concurrency = 0;
    let maximumConcurrency = 0;
    const queue = new CompanionReviewQueue({
      runReview: vi.fn(async ({ snapshot: current }: { snapshot: { digest: string } }) => {
        starts.push(current.digest);
        concurrency += 1;
        maximumConcurrency = Math.max(maximumConcurrency, concurrency);
        try {
          if (current.digest === 'failing') {
            await failing.promise;
            throw new Error('review failed');
          }
          if (current.digest === 'completion') await completion.promise;
        } finally {
          concurrency -= 1;
        }
      }),
    });

    const failed = queue.enqueue(request('failing'));
    const pending = queue.enqueue(request('pending', 'forced'));
    failing.resolve();
    const final = failed.catch(async () => queue.complete(request('completion', 'completion')));
    const afterFailure = failed.catch(async () => queue.enqueue(request('after-failure')));
    await expect(failed).rejects.toThrow('review failed');
    await expect(pending).rejects.toThrow('review failed');
    completion.resolve();
    await Promise.all([final, afterFailure]);

    expect(starts).toEqual(['failing', 'completion', 'after-failure']);
    expect(maximumConcurrency).toBe(1);
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
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        ));
      }),
    });
    const active = queue.enqueue(request('active'));
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
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
