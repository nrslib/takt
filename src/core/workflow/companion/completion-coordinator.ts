import type { CompanionFindingEvidence, WorkflowState } from '../../models/types.js';
import type { CompanionChangeDetector } from './change-detector.js';
import type { CompanionDiff } from './diff-reader.js';
import { isAbortError } from './abort.js';
import type { CompanionEventPublisher } from './event-publisher.js';
import type { CompanionReviewQueue } from './review-queue.js';
import type { CompanionTerminalDecisionTracker } from './terminal-decision.js';

export interface CompanionCompletionResult {
  readonly openMustFix: CompanionFindingEvidence[];
  readonly escalated: boolean;
  readonly completionVerified: boolean;
  readonly reason?: string;
}

export class CompanionCompletionCoordinator {
  constructor(private readonly input: {
    readonly activeNames: () => readonly string[];
    readonly detectors: ReadonlyMap<string, CompanionChangeDetector>;
    readonly queue: CompanionReviewQueue;
    readonly readSnapshot: () => Promise<CompanionDiff>;
    readonly synchronizeSnapshot: (snapshot: CompanionDiff) => void;
    readonly openMustFix: () => CompanionFindingEvidence[];
    readonly recordCompletionRound: (snapshot: CompanionDiff) => Promise<void>;
    readonly decision: CompanionTerminalDecisionTracker;
    readonly events: CompanionEventPublisher;
    readonly abortSignal?: AbortSignal;
    readonly onError: () => void;
  }) {}

  async complete(state: WorkflowState): Promise<CompanionCompletionResult> {
    this.input.abortSignal?.throwIfAborted();
    const candidates = new Map([...this.input.detectors].map(([name, detector]) => [
      name,
      detector.getCompletionCandidate(),
    ]));
    let reviewedSnapshot: CompanionDiff | undefined;
    let completionVerified = false;
    try {
      const snapshot = await this.input.readSnapshot();
      await this.completeQueues(snapshot, candidates);
      this.input.synchronizeSnapshot(snapshot);
      reviewedSnapshot = snapshot;
    } catch (error) {
      if (isAbortError(error) || this.input.abortSignal?.aborted) throw error;
      this.preserveCompletionFailure();
      await this.settleQueuesAfterFailure();
    }

    const openMustFix = this.input.openMustFix();
    if (reviewedSnapshot !== undefined) {
      try {
        await this.input.recordCompletionRound(reviewedSnapshot);
        completionVerified = true;
      } catch (error) {
        if (isAbortError(error) || this.input.abortSignal?.aborted) throw error;
        this.preserveCompletionFailure();
      }
    }
    const decision = this.input.decision.get();
    state.companion = {
      escalated: decision.decision === 'escalate',
      completionVerified,
      openMustFixCount: openMustFix.length,
      openMustFix,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
    if (openMustFix.length === 0 || decision.decision === 'escalate') {
      this.input.events.complete(openMustFix.length, decision.decision === 'escalate');
    }
    return {
      openMustFix,
      escalated: decision.decision === 'escalate',
      completionVerified,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  }

  private async completeQueues(
    snapshot: CompanionDiff,
    candidates: ReadonlyMap<string, ReturnType<CompanionChangeDetector['getCompletionCandidate']>>,
  ): Promise<void> {
    const results = await Promise.allSettled(this.input.activeNames().map(async (name) => {
      const detector = this.input.detectors.get(name);
      const candidate = candidates.get(name);
      if (detector === undefined || candidate === undefined) {
        throw new Error(`Missing completion state for companion "${name}"`);
      }
      const trigger = await detector.evaluateCandidate(candidate, snapshot);
      if (trigger === undefined) {
        await this.input.queue.settle(name);
        return;
      }
      await this.input.queue.complete({ companionName: name, ...trigger });
    }));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  private async settleQueues(): Promise<void> {
    const results = await Promise.allSettled(
      this.input.activeNames().map((name) => this.input.queue.settle(name)),
    );
    const failure = results.find((result): result is PromiseRejectedResult => (
      result.status === 'rejected'
    ));
    if (failure !== undefined) throw failure.reason;
  }

  private async settleQueuesAfterFailure(): Promise<void> {
    try {
      await this.settleQueues();
    } catch (error) {
      if (isAbortError(error) || this.input.abortSignal?.aborted) throw error;
      this.preserveCompletionFailure();
    }
  }

  private preserveCompletionFailure(): void {
    this.input.onError();
    this.input.decision.preserveUnreviewedCompletionAfterFailure();
  }
}
