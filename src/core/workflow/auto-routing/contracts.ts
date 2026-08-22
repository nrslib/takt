import type { RoutingTier } from '../../models/config-types.js';
import type { ProviderActivityCallback, StreamCallback } from '../../../shared/types/provider.js';

export type { RoutingTier };

export const ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY = Symbol('routingWorkSnapshotLocalIdentity');

export interface RoutingWorkSnapshotLocalIdentity {
  readonly workDigest: string;
  readonly totalWorkCount: number;
  readonly omittedWorkCount: number;
  readonly sensitiveValues: readonly string[];
}

export interface RoutingWorkSnapshot {
  readonly goal: string;
  readonly step: Readonly<{
    name: string;
    tags: readonly string[];
    personaKey?: string;
    instruction?: string;
    stepType: 'normal' | 'parallel' | 'agent';
    edit?: boolean;
  }>;
  readonly remainingWork: ReadonlyArray<Readonly<{
    source: 'task' | 'team-part' | 'prior-result';
    title?: string;
    description: string;
  }>>;
  readonly progress: Readonly<{
    previousAttemptFailed: boolean;
    noProgress: boolean;
    retryingSameWork: boolean;
  }>;
  readonly [ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY]?: Readonly<RoutingWorkSnapshotLocalIdentity>;
}

export type RoutingModelInput = Omit<RoutingWorkSnapshot, typeof ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY> & {
  version: string;
  remainingWorkOmittedCount?: number;
};

export interface WorkRequirementEstimate {
  requiredTier: RoutingTier;
  reasonCodes: string[];
  confidence?: number;
}

export const ROUTING_REASON_CODE_VALUES = [
  'api-change',
  'complex-work',
  'focused-change',
  'formatting',
  'initial-complexity',
  'local-change',
] as const;

const ROUTING_REASON_CODES = new Set<string>(ROUTING_REASON_CODE_VALUES);
export const MAX_ROUTING_REASON_CODES = 4;
export const MAX_ROUTING_REASON_CODE_LENGTH = 32;

export function validateRoutingReasonCodes(reasonCodes: unknown): asserts reasonCodes is string[] {
  if (!Array.isArray(reasonCodes) || reasonCodes.length > MAX_ROUTING_REASON_CODES) {
    throw new Error('Auto routing estimator response has invalid reason_codes');
  }
  if (reasonCodes.some((code) =>
    typeof code !== 'string'
    || code.length === 0
    || code.length > MAX_ROUTING_REASON_CODE_LENGTH
    || !ROUTING_REASON_CODES.has(code))) {
    throw new Error('Auto routing estimator response has invalid reason_codes');
  }
}

export interface WorkRequirementEstimator {
  estimate(input: RoutingModelInput, options?: {
    abortSignal?: AbortSignal;
    onStream?: StreamCallback;
    onActivity?: ProviderActivityCallback;
  }): Promise<WorkRequirementEstimate>;
}
