import type { StreamEvent } from '../../../shared/types/provider.js';
import type { CompanionDiff } from './diff-reader.js';
import {
  CompanionChangeDetector,
  COMPANION_CHANGE_DEBOUNCE_MS,
  type CompanionChangeCandidate,
} from './change-detector.js';
import { isGitCommitCommand } from './git-command.js';
import type { CompanionReviewQueue } from './review-queue.js';
import { isAbortError } from './abort.js';

export class CompanionTriggerScheduler {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private evaluating = false;
  private pendingEvaluation = false;
  private completing = false;
  private knownSnapshot: CompanionDiff;
  private readonly knownSnapshotGenerations = new Map<string, number>();
  private evaluationEpoch = 0;
  private readonly pendingBash = new Map<string, {
    readonly detectors: ReadonlyMap<string, {
      readonly dirty: boolean;
      readonly generation: number;
      readonly snapshotGeneration: number;
    }>;
    readonly evaluationEpoch: number;
  }>();
  private readonly pendingBashIds: string[] = [];

  constructor(private readonly input: {
    readonly detectors: ReadonlyMap<string, CompanionChangeDetector>;
    readonly intervals: readonly number[];
    readonly allowGitCommit: boolean;
    readonly queue: CompanionReviewQueue;
    readonly initialSnapshot: CompanionDiff;
    readonly readSnapshot: () => Promise<CompanionDiff>;
    readonly isAborted: () => boolean;
    readonly onError: () => void;
  }) {
    this.knownSnapshot = input.initialSnapshot;
    for (const [name, detector] of input.detectors) {
      this.knownSnapshotGenerations.set(name, detector.getObservedGeneration());
    }
  }

  observe(event: StreamEvent): void {
    if (event.type === 'tool_result') {
      this.observeBashResult(event.data.id);
      return;
    }
    const command = event.type === 'tool_use' && isBashTool(event.data.tool)
      ? event.data.input.command
      : undefined;
    const gitCommit = typeof command === 'string' && isGitCommitCommand(command);
    if (
      event.type === 'tool_use'
      && isBashTool(event.data.tool)
      && !(this.input.allowGitCommit && gitCommit)
    ) {
      this.observeBashUse(event.data.id);
    }
    const commit = this.input.allowGitCommit
      && gitCommit;
    let observedChange = false;
    for (const detector of this.input.detectors.values()) {
      if (commit) {
        detector.observeCommit();
        observedChange = true;
      } else {
        observedChange = detector.observe(event) || observedChange;
      }
    }
    if (commit) void this.evaluateNow();
    else if (observedChange) this.scheduleDebouncedEvaluation();
  }

  start(): void {
    this.completing = false;
    if (this.pollTimer !== undefined || this.input.intervals.length === 0) return;
    const interval = Math.max(250, Math.min(...this.input.intervals));
    this.pollTimer = setInterval(() => void this.evaluateNow(), interval);
  }

  beginCompletion(): void {
    this.completing = true;
    this.stop();
  }

  synchronizeSnapshot(snapshot: CompanionDiff): void {
    this.knownSnapshot = snapshot;
    for (const [name, detector] of this.input.detectors) {
      this.knownSnapshotGenerations.set(name, detector.getObservedGeneration());
    }
  }

  stop(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pendingBash.clear();
    this.pendingBashIds.splice(0);
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating) {
      this.pendingEvaluation = true;
      return;
    }
    if (this.completing || this.input.isAborted()) return;
    const candidates = this.liveCandidates();
    if (candidates.length === 0) return;
    this.evaluating = true;
    this.evaluationEpoch += 1;
    const evaluationGenerations = new Map([...this.input.detectors].map(([name, detector]) => [
      name,
      detector.getObservedGeneration(),
    ]));
    try {
      const snapshot = await this.input.readSnapshot();
      this.knownSnapshot = snapshot;
      for (const [name, generation] of evaluationGenerations) {
        this.knownSnapshotGenerations.set(name, generation);
      }
      await Promise.all(candidates.map(async ({ name, detector, candidate }) => {
        const trigger = await detector.evaluateCandidate(candidate, snapshot);
        if (trigger === undefined || this.completing) return;
        await this.input.queue.enqueue({ companionName: name, ...trigger });
      }));
    } catch (error) {
      if (!this.input.isAborted() && !isAbortError(error)) this.input.onError();
    } finally {
      this.evaluating = false;
      if (this.pendingEvaluation) {
        this.pendingEvaluation = false;
        this.scheduleDebouncedEvaluation();
      }
    }
  }

  private liveCandidates(): Array<{
    readonly name: string;
    readonly detector: CompanionChangeDetector;
    readonly candidate: CompanionChangeCandidate;
  }> {
    return [...this.input.detectors].flatMap(([name, detector]) => {
      const candidate = detector.getTriggerCandidate(COMPANION_CHANGE_DEBOUNCE_MS);
      return candidate === undefined ? [] : [{ name, detector, candidate }];
    });
  }

  private scheduleDebouncedEvaluation(): void {
    if (this.completing || this.input.isAborted()) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.evaluateNow();
    }, COMPANION_CHANGE_DEBOUNCE_MS);
  }

  private observeBashUse(id: string): void {
    this.pendingBash.set(id, {
      detectors: new Map([...this.input.detectors].map(([name, detector]) => [
        name,
        {
          dirty: detector.isDirty(),
          generation: detector.getObservedGeneration(),
          snapshotGeneration: this.knownSnapshotGenerations.get(name)!,
        },
      ])),
      evaluationEpoch: this.evaluationEpoch,
    });
    this.pendingBashIds.push(id);
  }

  private observeBashResult(id: string | undefined): void {
    const matchedId = id === undefined
      ? this.pendingBashIds[0]
      : this.pendingBash.has(id) ? id : undefined;
    if (matchedId === undefined) return;
    const pending = this.pendingBash.get(matchedId);
    if (pending === undefined) return;
    this.pendingBash.delete(matchedId);
    removePendingBashId(this.pendingBashIds, matchedId);
    void this.probeBashCompletion(pending).catch((error) => {
      if (!this.input.isAborted() && !isAbortError(error)) this.input.onError();
    });
  }

  private async probeBashCompletion(pending: {
    readonly detectors: ReadonlyMap<string, {
      readonly dirty: boolean;
      readonly generation: number;
      readonly snapshotGeneration: number;
    }>;
    readonly evaluationEpoch: number;
  }): Promise<void> {
    const snapshotBefore = this.knownSnapshot;
    const snapshotAfter = await this.input.readSnapshot();
    this.knownSnapshot = snapshotAfter;
    const snapshotChanged = snapshotBefore.digest !== snapshotAfter.digest;
    const evaluationCrossed = this.evaluating || this.evaluationEpoch !== pending.evaluationEpoch;
    let observedChange = false;
    for (const [name, detector] of this.input.detectors) {
      const pendingDetector = pending.detectors.get(name)!;
      const cacheCoversDirtyGeneration = pendingDetector.snapshotGeneration
        >= pendingDetector.generation;
      const explicitChangeAfterBash = detector.getObservedGeneration() > pendingDetector.generation;
      if (
        snapshotChanged
        && (
          evaluationCrossed
          || (
            !explicitChangeAfterBash
            && !(pendingDetector.dirty && detector.isDirty() && !cacheCoversDirtyGeneration)
          )
        )
      ) {
        observedChange = detector.observeSnapshotChange(snapshotBefore, snapshotAfter)
          || observedChange;
      }
      this.knownSnapshotGenerations.set(name, detector.getObservedGeneration());
    }
    if (observedChange) this.scheduleDebouncedEvaluation();
  }
}

function removePendingBashId(ids: string[], id: string): void {
  const index = ids.indexOf(id);
  if (index !== -1) ids.splice(index, 1);
}

function isBashTool(tool: string): boolean {
  return tool === 'Bash' || tool === 'bash';
}
