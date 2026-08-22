import type { StreamEvent } from '../../../shared/types/provider.js';
import type { CompanionDiff } from './diff-reader.js';

const FORCE_INTERVAL_MULTIPLIER = 4;
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'apply_patch', 'write', 'edit']);

export const COMPANION_CHANGE_DEBOUNCE_MS = 250;

export interface CompanionChangeCandidate {
  readonly reason: 'quiet' | 'forced' | 'completion' | 'commit';
  readonly observedGeneration: number;
}

export interface CompanionChangeTrigger extends CompanionChangeCandidate {
  readonly snapshot: CompanionDiff;
}

export type CompanionChangeSkipReason =
  | 'empty_diff'
  | 'unchanged_digest'
  | 'below_minimum_changed_lines';

export class CompanionChangeDetector {
  private readonly intervalMs: number;
  private readonly minimumChangedLines: number;
  private readonly now: () => number;
  private readonly readDiff: () => Promise<CompanionDiff>;
  private dirtySince: number | undefined;
  private lastChangeAt: number | undefined;
  private lastReviewedDigest: string | undefined;
  private generation = 0;
  private immediateGeneration: number | undefined;

  constructor(input: {
    intervalMs: number;
    minimumChangedLines: number;
    now: () => number;
    readDiff: () => Promise<CompanionDiff>;
  }) {
    this.intervalMs = input.intervalMs;
    this.minimumChangedLines = input.minimumChangedLines;
    this.now = input.now;
    this.readDiff = input.readDiff;
  }

  observe(event: StreamEvent): boolean {
    if (event.type !== 'tool_use' || !this.isMutatingTool(event.data.tool)) return false;
    const timestamp = this.now();
    this.generation += 1;
    this.dirtySince ??= timestamp;
    this.lastChangeAt = timestamp;
    return true;
  }

  observeCommit(): void {
    const timestamp = this.now();
    this.generation += 1;
    this.dirtySince ??= timestamp;
    this.lastChangeAt = timestamp;
    this.immediateGeneration = this.generation;
  }

  observeSnapshotChange(before: CompanionDiff, after: CompanionDiff): boolean {
    if (before.digest === after.digest) return false;
    const timestamp = this.now();
    this.generation += 1;
    this.dirtySince ??= timestamp;
    this.lastChangeAt = timestamp;
    return true;
  }

  isDirty(): boolean {
    return this.dirtySince !== undefined;
  }

  getObservedGeneration(): number {
    return this.generation;
  }

  markReviewed(snapshot: CompanionDiff, observedGeneration: number): void {
    this.lastReviewedDigest = snapshot.digest;
    this.consumeThrough(observedGeneration);
  }

  getTriggerCandidate(quietIntervalMs: number): CompanionChangeCandidate | undefined {
    if (this.dirtySince === undefined || this.lastChangeAt === undefined) return undefined;
    const elapsed = this.now() - this.dirtySince;
    const quiet = this.now() - this.lastChangeAt >= quietIntervalMs;
    const forced = elapsed >= this.intervalMs * FORCE_INTERVAL_MULTIPLIER;
    const immediate = this.immediateGeneration !== undefined;
    if (!quiet && !forced && !immediate) return undefined;
    return {
      reason: immediate ? 'commit' : forced ? 'forced' : 'quiet',
      observedGeneration: this.generation,
    };
  }

  getCompletionCandidate(): CompanionChangeCandidate {
    return {
      reason: 'completion',
      observedGeneration: this.generation,
    };
  }

  async evaluateCandidate(
    candidate: CompanionChangeCandidate,
    providedSnapshot?: CompanionDiff,
    onSkipped?: (reason: CompanionChangeSkipReason) => void,
  ): Promise<CompanionChangeTrigger | undefined> {
    const snapshot = providedSnapshot ?? await this.readDiff();
    const ignoreMinimum = candidate.reason === 'completion' || candidate.reason === 'commit';
    const skipReason = snapshot.changedLines === 0 && snapshot.changedFiles.length === 0
      ? 'empty_diff'
      : snapshot.digest === this.lastReviewedDigest
        ? 'unchanged_digest'
        : !ignoreMinimum && snapshot.changedLines < this.minimumChangedLines
          ? 'below_minimum_changed_lines'
          : undefined;
    if (skipReason !== undefined) {
      this.consumeThrough(candidate.observedGeneration);
      onSkipped?.(skipReason);
      return undefined;
    }
    return { snapshot, ...candidate };
  }

  private consumeThrough(observedGeneration: number): void {
    if (this.generation <= observedGeneration) {
      this.dirtySince = undefined;
      this.lastChangeAt = undefined;
      this.immediateGeneration = undefined;
      return;
    }
    this.dirtySince = this.lastChangeAt;
    if (
      this.immediateGeneration !== undefined
      && this.immediateGeneration <= observedGeneration
    ) {
      this.immediateGeneration = undefined;
    }
  }

  private isMutatingTool(tool: string): boolean {
    return MUTATING_TOOLS.has(tool);
  }
}
