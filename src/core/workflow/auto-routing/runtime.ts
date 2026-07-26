import type { AutoRoutingConfig, RoutingTier } from '../../models/config-types.js';
import type { RoutingWorkSnapshot, WorkRequirementEstimate, WorkRequirementEstimator } from './contracts.js';
import {
  createRoutingModelInputDigest,
  createRoutingWorkFingerprint,
  getRoutingInputTokenBucket,
  normalizeRoutingWorkSnapshot,
} from './normalizer.js';
import { maxRoutingTier, promoteRoutingTier, selectRoutingCandidate } from './selector.js';

type PreviousResolution = {
  fingerprint: string;
  requiredTier: RoutingTier;
  selectedTier: RoutingTier;
  status?: 'failed' | 'done';
  madeProgress?: boolean;
};

export class RoutingRuntime {
  private readonly resolutions = new Map<string, PreviousResolution>();
  private readonly estimates = new Map<string, WorkRequirementEstimate>();

  constructor(private readonly options: { autoRouting: AutoRoutingConfig; estimator: WorkRequirementEstimator }) {}

  async resolve(input: { scope: string; snapshot: RoutingWorkSnapshot; abortSignal?: AbortSignal }) {
    input.abortSignal?.throwIfAborted();
    const fingerprint = createRoutingWorkFingerprint(input.snapshot);
    const previous = this.resolutions.get(input.scope);
    const fingerprintChanged = previous !== undefined && previous.fingerprint !== fingerprint;
    const snapshot = this.withProgress(input.snapshot, previous, fingerprint);
    const modelInput = normalizeRoutingWorkSnapshot(snapshot);
    const estimateCacheKey = [modelInput.version, fingerprint, createRoutingModelInputDigest(modelInput)].join(':');
    const estimatorStartedAt = Date.now();
    let estimate: WorkRequirementEstimate;
    try {
      const cachedEstimate = this.estimates.get(estimateCacheKey);
      if (cachedEstimate !== undefined) {
        estimate = cachedEstimate;
      } else {
        estimate = await this.options.estimator.estimate(modelInput, {
          abortSignal: input.abortSignal,
        });
        this.estimates.set(estimateCacheKey, this.copyEstimate(estimate));
      }
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw input.abortSignal.reason;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      return this.resolveFallback(
        input.scope,
        fingerprint,
        fingerprintChanged,
        input.snapshot,
        previous,
        error as Error,
        Math.max(0, Date.now() - estimatorStartedAt),
        getRoutingInputTokenBucket(modelInput),
      );
    }
    return this.resolveEstimated(
      input.scope,
      fingerprint,
      fingerprintChanged,
      snapshot,
      estimate,
      previous,
      Math.max(0, Date.now() - estimatorStartedAt),
      getRoutingInputTokenBucket(modelInput),
    );
  }

  recordExecutionResult(input: { scope: string; status: 'failed' | 'done'; madeProgress?: boolean }): void {
    const previous = this.resolutions.get(input.scope);
    if (previous === undefined) throw new Error(`Cannot record routing result for unknown scope "${input.scope}"`);
    this.resolutions.set(input.scope, { ...previous, status: input.status, madeProgress: input.madeProgress === true });
  }

  hasResolution(scope: string): boolean {
    return this.resolutions.has(scope);
  }

  private resolveEstimated(
    scope: string,
    fingerprint: string,
    fingerprintChanged: boolean,
    snapshot: RoutingWorkSnapshot,
    estimate: WorkRequirementEstimate,
    previous: PreviousResolution | undefined,
    estimatorDurationMs: number,
    inputTokenBucket: 'small' | 'medium' | 'large',
  ) {
    const requiredTier = this.resolveRequiredTier(estimate.requiredTier, previous, fingerprint);
    const selection = selectRoutingCandidate({
      autoRouting: this.options.autoRouting,
      step: this.selectionStep(snapshot),
      estimate: { ...estimate, requiredTier },
    });
    this.resolutions.set(scope, { fingerprint, requiredTier, selectedTier: selection.candidate.routingTier });
    return {
      ...selection,
      requiredTier,
      reasonCodes: [...estimate.reasonCodes],
      fingerprintChanged,
      escalationReason: this.escalationReason(previous, fingerprint),
      estimatorDurationMs,
      inputTokenBucket,
    };
  }

  private resolveFallback(
    scope: string,
    fingerprint: string,
    fingerprintChanged: boolean,
    snapshot: RoutingWorkSnapshot,
    previous: PreviousResolution | undefined,
    error: Error,
    estimatorDurationMs: number,
    inputTokenBucket: 'small' | 'medium' | 'large',
  ) {
    const selection = selectRoutingCandidate({
      autoRouting: this.options.autoRouting,
      step: this.selectionStep(snapshot),
      estimatorFailure: error,
    });
    const requiredTier = this.resolveRequiredTier(selection.candidate.routingTier, previous, fingerprint);
    if (maxRoutingTier(selection.candidate.routingTier, requiredTier) !== selection.candidate.routingTier) {
      throw new Error(`Configured auto routing fallback "${selection.candidate.name}" does not meet required ${requiredTier} routing tier`);
    }
    this.resolutions.set(scope, {
      fingerprint,
      requiredTier,
      selectedTier: selection.candidate.routingTier,
    });
    return {
      ...selection,
      requiredTier,
      reasonCodes: undefined,
      fingerprintChanged,
      escalationReason: this.escalationReason(previous, fingerprint),
      estimatorDurationMs,
      inputTokenBucket,
    };
  }

  private resolveRequiredTier(estimated: RoutingTier, previous: PreviousResolution | undefined, fingerprint: string): RoutingTier {
    if (previous === undefined || previous.fingerprint !== fingerprint) return estimated;
    const floor = maxRoutingTier(estimated, previous.requiredTier);
    return previous.status !== undefined && previous.madeProgress === false ? promoteRoutingTier(floor) : floor;
  }

  private escalationReason(previous: PreviousResolution | undefined, fingerprint: string): 'failed-without-progress' | 'no-progress' | undefined {
    if (previous?.fingerprint !== fingerprint || previous.madeProgress !== false) return undefined;
    return previous.status === 'failed' ? 'failed-without-progress' : previous.status === 'done' ? 'no-progress' : undefined;
  }

  private withProgress(
    snapshot: RoutingWorkSnapshot,
    previous: PreviousResolution | undefined,
    fingerprint: string,
  ): RoutingWorkSnapshot {
    if (previous === undefined || previous.fingerprint !== fingerprint) {
      return snapshot;
    }
    const previousAttemptFailed = previous.status === 'failed';
    const noProgress = previous.status !== undefined && previous.madeProgress === false;
    return {
      ...snapshot,
      progress: {
        previousAttemptFailed,
        noProgress,
        retryingSameWork: true,
      },
    };
  }

  private copyEstimate(estimate: WorkRequirementEstimate): WorkRequirementEstimate {
    return {
      ...estimate,
      reasonCodes: [...estimate.reasonCodes],
    };
  }

  private selectionStep(snapshot: RoutingWorkSnapshot): { name: string; tags: string[]; personaKey?: string } {
    return {
      name: snapshot.step.name,
      tags: [...snapshot.step.tags],
      ...(snapshot.step.personaKey !== undefined ? { personaKey: snapshot.step.personaKey } : {}),
    };
  }
}
