import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import type {
  CompanionChangeCandidate,
  CompanionChangeDetector,
  CompanionChangeSkipReason,
} from './change-detector.js';
import type { CompanionDiff } from './diff-reader.js';
import type { CompanionReviewQueue } from './review-queue.js';

export interface CompanionCompletionResult {
  readonly completionSettled: boolean;
  readonly completionFailure: boolean;
  readonly digest?: string;
  readonly reason?: string;
}

export class CompanionCompletionCoordinator {
  constructor(private readonly input: {
    readonly activeNames: () => readonly string[];
    readonly detectors: ReadonlyMap<string, CompanionChangeDetector>;
    readonly queue: CompanionReviewQueue;
    readonly readSnapshot: () => Promise<CompanionDiff>;
    readonly synchronizeSnapshot: (snapshot: CompanionDiff) => void;
    readonly abortSignal?: AbortSignal;
    readonly onError: (error: unknown) => void;
    readonly onSkipped?: (input: {
      readonly companionName: string;
      readonly reason: CompanionChangeSkipReason;
      readonly candidate: CompanionChangeCandidate;
    }) => void;
  }) {}

  async complete(): Promise<CompanionCompletionResult> {
    this.input.abortSignal?.throwIfAborted();
    const activeNames = this.input.activeNames();
    if (activeNames.length === 0) {
      return { completionSettled: true, completionFailure: false };
    }

    try {
      await Promise.all(activeNames.map((name) => this.input.queue.drain(name)));
      const snapshot = await this.input.readSnapshot();
      this.input.synchronizeSnapshot(snapshot);
      await this.reviewUnreviewedSnapshot(activeNames, snapshot);
      return {
        completionSettled: true,
        completionFailure: false,
        digest: snapshot.digest,
      };
    } catch (error) {
      if (this.input.abortSignal?.aborted) throw error;
      this.input.onError(error);
      return {
        completionSettled: false,
        completionFailure: true,
        reason: safeExternalErrorMessage(error),
      };
    }
  }

  private async reviewUnreviewedSnapshot(
    activeNames: readonly string[],
    snapshot: CompanionDiff,
  ): Promise<void> {
    const results = await Promise.allSettled(activeNames.map(async (name) => {
      const detector = this.input.detectors.get(name);
      if (detector === undefined) {
        throw new Error(`Missing completion state for companion "${name}"`);
      }
      const candidate = detector.getCompletionCandidate();
      let skippedReason: CompanionChangeSkipReason | undefined;
      const trigger = await detector.evaluateCandidate(candidate, snapshot, (reason) => {
        skippedReason = reason;
      });
      if (skippedReason !== undefined) {
        this.input.onSkipped?.({ companionName: name, reason: skippedReason, candidate });
      }
      if (trigger !== undefined) {
        await this.input.queue.complete({ companionName: name, ...trigger });
      }
    }));
    const failure = results.find((result): result is PromiseRejectedResult => (
      result.status === 'rejected'
    ));
    if (failure !== undefined) throw failure.reason;
  }
}
