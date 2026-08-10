import type { StreamEvent } from '../../../shared/types/provider.js';
import type { CompanionDiff } from './diff-reader.js';
import {
  CompanionChangeDetector,
  type CompanionChangeCandidate,
} from './change-detector.js';
import { isGitCommitCommand } from './git-command.js';
import type { CompanionReviewQueue } from './review-queue.js';
import { isAbortError } from './abort.js';

export class CompanionTriggerScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private evaluating = false;
  private completing = false;

  constructor(private readonly input: {
    readonly detectors: ReadonlyMap<string, CompanionChangeDetector>;
    readonly intervals: readonly number[];
    readonly allowGitCommit: boolean;
    readonly queue: CompanionReviewQueue;
    readonly readSnapshot: () => Promise<CompanionDiff>;
    readonly isAborted: () => boolean;
    readonly onError: () => void;
  }) {}

  observe(event: StreamEvent): void {
    const command = event.type === 'tool_use' && event.data.tool === 'Bash'
      ? event.data.input.command
      : undefined;
    const commit = this.input.allowGitCommit
      && typeof command === 'string'
      && isGitCommitCommand(command);
    for (const detector of this.input.detectors.values()) {
      if (commit) detector.observeCommit();
      else detector.observe(event);
    }
    if (commit) void this.evaluateNow();
  }

  start(): void {
    this.completing = false;
    if (this.timer !== undefined || this.input.intervals.length === 0) return;
    const interval = Math.max(250, Math.min(...this.input.intervals));
    this.timer = setInterval(() => void this.evaluateNow(), interval);
  }

  beginCompletion(): void {
    this.completing = true;
    this.stop();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating || this.completing || this.input.isAborted()) return;
    const candidates = this.liveCandidates();
    if (candidates.length === 0) return;
    this.evaluating = true;
    try {
      const snapshot = await this.input.readSnapshot();
      await Promise.all(candidates.map(async ({ name, detector, candidate }) => {
        const trigger = await detector.evaluateCandidate(candidate, snapshot);
        if (trigger === undefined || this.completing) return;
        await this.input.queue.enqueue({ companionName: name, ...trigger });
      }));
    } catch (error) {
      if (!this.input.isAborted() && !isAbortError(error)) this.input.onError();
    } finally {
      this.evaluating = false;
    }
  }

  private liveCandidates(): Array<{
    readonly name: string;
    readonly detector: CompanionChangeDetector;
    readonly candidate: CompanionChangeCandidate;
  }> {
    return [...this.input.detectors].flatMap(([name, detector]) => {
      const candidate = detector.getTriggerCandidate();
      return candidate === undefined ? [] : [{ name, detector, candidate }];
    });
  }
}
