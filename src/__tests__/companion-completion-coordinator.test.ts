import { describe, expect, it, vi } from 'vitest';
import { CompanionChangeDetector } from '../core/workflow/companion/change-detector.js';
import { CompanionCompletionCoordinator } from '../core/workflow/companion/completion-coordinator.js';

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

function detector() {
  return new CompanionChangeDetector({
    intervalMs: 1_000,
    minimumChangedLines: 10,
    now: () => 0,
    readDiff: vi.fn().mockResolvedValue(snapshot),
  });
}

describe('companion completion coordinator', () => {
  it('orders drain before snapshot comparison and completion review', async () => {
    const order: string[] = [];
    const queue = {
      drain: vi.fn(async () => { order.push('drain'); }),
      complete: vi.fn(async () => { order.push('review'); }),
    };
    const coordinator = new CompanionCompletionCoordinator({
      activeNames: () => ['reviewer'],
      detectors: new Map([['reviewer', detector()]]),
      queue: queue as never,
      readSnapshot: vi.fn(async () => { order.push('snapshot'); return snapshot; }),
      synchronizeSnapshot: vi.fn(() => { order.push('synchronize'); }),
      onError: vi.fn(),
    });

    await expect(coordinator.complete()).resolves.toMatchObject({
      completionSettled: true,
      completionFailure: false,
      digest: 'digest-1',
    });
    expect(order).toEqual(['drain', 'snapshot', 'synchronize', 'review']);
  });

  it('skips completion review when the current digest was already reviewed', async () => {
    const reviewed = detector();
    reviewed.markReviewed(snapshot, 0);
    const queue = { drain: vi.fn(), complete: vi.fn() };
    const coordinator = new CompanionCompletionCoordinator({
      activeNames: () => ['reviewer'],
      detectors: new Map([['reviewer', reviewed]]),
      queue: queue as never,
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      synchronizeSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    await coordinator.complete();
    expect(queue.drain).toHaveBeenCalledOnce();
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it('settles immediately when no companion is active', async () => {
    const readSnapshot = vi.fn();
    const coordinator = new CompanionCompletionCoordinator({
      activeNames: () => [],
      detectors: new Map(),
      queue: {} as never,
      readSnapshot,
      synchronizeSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    await expect(coordinator.complete()).resolves.toEqual({
      completionSettled: true,
      completionFailure: false,
    });
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('sanitizes completion failures before exposing the reason', async () => {
    const coordinator = new CompanionCompletionCoordinator({
      activeNames: () => ['reviewer'],
      detectors: new Map([['reviewer', detector()]]),
      queue: {
        drain: vi.fn(),
        complete: vi.fn().mockRejectedValue(
          new Error('Provider failed: token=super-secret at /Users/alice/private/config.json'),
        ),
      } as never,
      readSnapshot: vi.fn().mockResolvedValue(snapshot),
      synchronizeSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    await expect(coordinator.complete()).resolves.toEqual({
      completionSettled: false,
      completionFailure: true,
      reason: 'Provider failed: token=[REDACTED] at [path]',
    });
  });
});
