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

export class CompanionChangeDetector {
  private readonly intervalMs: number;
  private readonly minimumChangedLines: number;
  private readonly now: () => number;
  private readonly readDiff: () => Promise<CompanionDiff>;
  private dirtySince: number | undefined;
  private lastChangeAt: number | undefined;
  private lastReviewedDigest: string | undefined;
  private lastReviewedFileFingerprints: Readonly<Record<string, string>> | undefined;
  private lastReviewedHunkFingerprints: Readonly<Record<string, string>> | undefined;
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
    this.lastReviewedFileFingerprints = { ...snapshot.fileFingerprints };
    this.lastReviewedHunkFingerprints = { ...snapshot.hunkFingerprints };
    this.consumeThrough(observedGeneration);
  }

  changedRegionsSinceLastReview(snapshot: CompanionDiff): string[] {
    const previousFiles = this.lastReviewedFileFingerprints;
    const previousHunks = this.lastReviewedHunkFingerprints;
    if (previousFiles === undefined || previousHunks === undefined) {
      return regionsForInitialReview(snapshot);
    }
    const changedHunks = changedFingerprintKeys(previousHunks, snapshot.hunkFingerprints);
    const hunkFiles = new Set([
      ...Object.keys(previousHunks),
      ...Object.keys(snapshot.hunkFingerprints),
    ].map(regionFile));
    const changedFilesWithoutHunks = changedFingerprintKeys(
      previousFiles,
      snapshot.fileFingerprints,
    ).filter((path) => !hunkFiles.has(path));
    return [...changedHunks, ...changedFilesWithoutHunks];
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
    return { reason: 'completion', observedGeneration: this.generation };
  }

  async evaluateCandidate(
    candidate: CompanionChangeCandidate,
    providedSnapshot?: CompanionDiff,
  ): Promise<CompanionChangeTrigger | undefined> {
    const snapshot = providedSnapshot ?? await this.readDiff();
    const ignoreMinimum = candidate.reason === 'completion' || candidate.reason === 'commit';
    if (
      (snapshot.changedLines === 0 && snapshot.changedFiles.length === 0)
      || snapshot.digest === this.lastReviewedDigest
      || (!ignoreMinimum && snapshot.changedLines < this.minimumChangedLines)
    ) {
      this.consumeThrough(candidate.observedGeneration);
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

function regionsForInitialReview(snapshot: CompanionDiff): string[] {
  const regions = Object.keys(snapshot.hunkFingerprints);
  const filesWithHunks = new Set(regions.map(regionFile));
  return [
    ...regions,
    ...snapshot.changedFiles.filter((path) => !filesWithHunks.has(path)),
  ];
}

function changedFingerprintKeys(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => previous[key] !== current[key]);
}

function regionFile(region: string): string {
  const marker = /:(?:deleted-)?\d+-\d+$/u.exec(region);
  return marker === null ? region : region.slice(0, marker.index);
}
