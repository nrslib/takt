import { describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { CompanionChangeDetector } from '../core/workflow/companion/change-detector.js';
import { CompanionCompletionCoordinator } from '../core/workflow/companion/completion-coordinator.js';
import { CompanionEventPublisher } from '../core/workflow/companion/event-publisher.js';
import { CompanionReviewQueue } from '../core/workflow/companion/review-queue.js';
import { CompanionTerminalDecisionTracker } from '../core/workflow/companion/terminal-decision.js';
import type { CompanionFindingEvidence } from '../core/models/types.js';

const openFinding: CompanionFindingEvidence = {
  id: 'security-reviewer-1',
  severity: 'must_fix',
  file: 'src/a.ts',
  line: 1,
  finding: 'unsafe write',
};

const snapshot = {
  digest: 'reviewed',
  changedLines: 1,
  content: '+reviewed\n',
  changedFiles: ['src/a.ts'],
  fileFingerprints: { 'src/a.ts': 'reviewed' },
  hunkFingerprints: { 'src/a.ts:1-1': 'reviewed' },
  omittedBytes: 0,
  truncated: false,
};

function state(): WorkflowState {
  return { companion: undefined } as unknown as WorkflowState;
}

function detector(): CompanionChangeDetector {
  return new CompanionChangeDetector({
    intervalMs: 100,
    minimumChangedLines: 10,
    now: () => 1_000,
    readDiff: vi.fn(),
  });
}

describe('companion completion coordinator', () => {
  it('should settle a running review even when no new completion review is needed', async () => {
    const current = detector();
    current.markReviewed(snapshot, 0);
    const order: string[] = [];
    const queue = new CompanionReviewQueue({
      runReview: async ({ signal }) => {
        order.push('started');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('aborted');
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });
    const running = queue.enqueue({
      companionName: 'security-reviewer',
      snapshot,
      reason: 'quiet',
      observedGeneration: 0,
    });
    const runningRejection = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    const emit = vi.fn();
    const coordinator = createCoordinator({ current, queue, emit });

    await coordinator.complete(state());
    await runningRejection;

    expect(order).toEqual(['started', 'aborted']);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('should retain open must_fix and escalate when loop adjudication fails', async () => {
    const current = detector();
    current.markReviewed(snapshot, 0);
    const emit = vi.fn();
    const coordinator = createCoordinator({
      current,
      emit,
      openMustFix: [openFinding],
      recordCompletionRound: vi.fn().mockRejectedValue(new Error('judge secret detail')),
    });
    const workflowState = state();

    const result = await coordinator.complete(workflowState);

    expect(result).toMatchObject({
      escalated: true,
      openMustFix: [openFinding],
    });
    expect(workflowState.companion).toMatchObject({ escalated: true, openMustFixCount: 1 });
    expect(emit).toHaveBeenCalledWith('companion:complete', {
      step: 'implement',
      openMustFixCount: 1,
      escalated: true,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('judge secret detail');
  });

  it('should escalate when completion adjudication fails without open must_fix findings', async () => {
    const current = detector();
    current.markReviewed(snapshot, 0);
    const emit = vi.fn();
    const coordinator = createCoordinator({
      current,
      emit,
      recordCompletionRound: vi.fn().mockRejectedValue(new Error('private failure detail')),
    });
    const workflowState = state();

    const result = await coordinator.complete(workflowState);

    expect(result).toMatchObject({ escalated: true, openMustFix: [] });
    expect(workflowState.companion).toMatchObject({ escalated: true, openMustFixCount: 0 });
    expect(emit).toHaveBeenCalledWith('companion:complete', {
      step: 'implement',
      openMustFixCount: 0,
      escalated: true,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private failure detail');
  });

  it('should preserve dirty state when completion diff collection fails', async () => {
    const current = detector();
    current.observe({
      type: 'tool_use',
      data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'edit' },
    });
    const emit = vi.fn();
    const coordinator = createCoordinator({
      current,
      emit,
      readSnapshot: vi.fn().mockRejectedValue(new Error('bounded reader failed')),
    });
    const workflowState = state();

    const result = await coordinator.complete(workflowState);

    expect(current.isDirty()).toBe(true);
    expect(result).toMatchObject({ escalated: true, openMustFix: [] });
    expect(workflowState.companion).toMatchObject({ escalated: true, openMustFixCount: 0 });
    expect(emit).toHaveBeenCalledWith('companion:complete', {
      step: 'implement',
      openMustFixCount: 0,
      escalated: true,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('bounded reader failed');
  });

  it('should preserve dirty state and escalate when the completion review fails', async () => {
    const current = detector();
    current.observe({
      type: 'tool_use',
      data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'edit' },
    });
    const queue = new CompanionReviewQueue({
      runReview: vi.fn().mockRejectedValue(new Error('review failed')),
    });
    const coordinator = createCoordinator({ current, queue });

    const result = await coordinator.complete(state());

    expect(current.isDirty()).toBe(true);
    expect(result).toMatchObject({ escalated: true, openMustFix: [] });
  });

  it('should rethrow an abort without publishing completion', async () => {
    const current = detector();
    const emit = vi.fn();
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    const coordinator = createCoordinator({
      current,
      emit,
      readSnapshot: vi.fn().mockRejectedValue(abort),
    });

    await expect(coordinator.complete(state())).rejects.toBe(abort);

    expect(emit).not.toHaveBeenCalled();
  });

  it('should never downgrade a confirmed escalation to continue', () => {
    const decision = new CompanionTerminalDecisionTracker();
    decision.update({ decision: 'escalate', reason: 'loop' });

    decision.update({ decision: 'continue' });

    expect(decision.get()).toEqual({ decision: 'escalate', reason: 'loop' });
  });

  it('should isolate terminal decisions from update inputs and returned values', () => {
    const decision = new CompanionTerminalDecisionTracker();
    const input = { decision: 'escalate' as const, reason: 'loop' };
    decision.update(input);
    input.reason = 'mutated input';
    const exposed = decision.get();
    (exposed as { reason: string }).reason = 'mutated result';

    expect(decision.get()).toEqual({ decision: 'escalate', reason: 'loop' });
  });

  it('should publish companion completion only once', () => {
    const publisher = new CompanionEventPublisher('implement', vi.fn());

    publisher.complete(0, false);

    expect(() => publisher.complete(0, false)).toThrow(/already published/);
  });
});

function createCoordinator(input: {
  current: CompanionChangeDetector;
  queue?: CompanionReviewQueue;
  emit?: ReturnType<typeof vi.fn>;
  openMustFix?: CompanionFindingEvidence[];
  readSnapshot?: ReturnType<typeof vi.fn>;
  recordCompletionRound?: ReturnType<typeof vi.fn>;
}): CompanionCompletionCoordinator {
  const queue = input.queue ?? new CompanionReviewQueue({ runReview: vi.fn() });
  return new CompanionCompletionCoordinator({
    activeNames: () => ['security-reviewer'],
    detectors: new Map([['security-reviewer', input.current]]),
    queue,
    readSnapshot: input.readSnapshot ?? vi.fn().mockResolvedValue(snapshot),
    openMustFix: () => input.openMustFix ?? [],
    recordCompletionRound: input.recordCompletionRound ?? vi.fn(),
    decision: new CompanionTerminalDecisionTracker(),
    events: new CompanionEventPublisher('implement', input.emit ?? vi.fn()),
    onError: vi.fn(),
  });
}
