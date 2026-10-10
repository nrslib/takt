import type { MergeMethod } from '../../models/config-types.js';

export const PR_STATUS_TIMEOUT_MS = 15_000;

export interface PrStatusFetchOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class PrStatusTimeoutError extends Error {
  constructor() {
    super('PR status acquisition timed out');
    this.name = 'PrStatusTimeoutError';
  }
}

export interface PrExecutionContext {
  readonly prNumber: number;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly headRepositoryUrl: string;
  readonly headRepositoryPushUrls: readonly string[];
}

export interface PrStatus {
  number: number;
  headSha: string;
  ci: { finished: boolean; passed: boolean };
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
  readonly beforePrMergeCheck?: BeforePrMergeCheck;
  readonly prExecutionContext?: PrExecutionContext;
  readonly mergeMethod?: MergeMethod;
  readonly prGitOperations?: PrGitOperations;
}

export type BeforePrMergeCheck = (
  prNumber: number,
  headSha: string,
  signal?: AbortSignal,
) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

export interface PrGitOperations {
  fetch(remote: 'origin' | 'base', refspec: string): Promise<void>;
  push(refspec: string): Promise<void>;
}
