import type { MergeMethod } from '../../models/config-types.js';
import type { PrCiCheck, PrCiRerun } from './pr-ci.js';

export const PR_STATUS_TIMEOUT_MS = 15_000;

export interface PrStatusFetchOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly rerun?: PrCiRerun;
}

export class PrStatusTimeoutError extends Error {
  constructor() {
    super('PR status acquisition timed out');
    this.name = 'PrStatusTimeoutError';
  }
}

export class PrHeadObservationMismatchError extends Error {
  constructor(prNumber: number, readonly firstHeadSha: string, readonly lastHeadSha: string) {
    super(`Pull request #${prNumber} head changed while reading its metadata`);
    this.name = 'PrHeadObservationMismatchError';
  }
}

export interface PrExecutionContext {
  readonly prNumber: number;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly headRepositoryUrl: string;
  readonly headRepositoryPushUrls: readonly string[];
  readonly preserveConflictState?: boolean;
  readonly threatCheckMaxDiffBytes?: number;
}

export interface PrStatus {
  number: number;
  headSha: string;
  ci: { finished: boolean; passed: boolean; checks?: PrCiCheck[]; rerunHeadChange?: { reason: string } };
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  merged: boolean;
}

export interface PrDetails extends Omit<PrExecutionContext, 'prNumber'> {
  readonly number: number;
  readonly sameRepository: boolean;
}

export interface PrMergeOptions {
  readonly cacciaExecutionSource?: 'merge' | 'from_pr';
  readonly cacciaPushedHead?: CacciaPushedHead;
  readonly prMergePushRecorder?: PrMergePushRecorder;
  readonly prExecutionContext?: PrExecutionContext;
  readonly mergeMethod?: MergeMethod;
  readonly prGitOperations?: PrGitOperations;
}

export interface PrMergePushRecorder {
  record(headSha: string, previousRemoteHeadSha: string, context: PrExecutionContext): void;
}

export interface CacciaPushedHead {
  readonly headSha: string;
  readonly baseBranch: string;
  readonly headRepositoryUrl: string;
  readonly headRepositoryPushUrls: readonly string[];
}

export interface PrGitOperations {
  fetch(remote: 'origin' | 'base', refspec: string): Promise<void>;
  push(refspec: string): Promise<void>;
}
