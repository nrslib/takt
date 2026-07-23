import {
  FindingContractTeamLeaderDecisionValidationError,
  hasFindingContractEvidenceOrReferenceIssue,
  type FindingContractDecisionValidationIssue,
  type FindingContractRejectedDecisionDigest,
} from '../team-leader-finding-contract-decision-validation.js';

export const FINDING_CONTRACT_DECISION_NORMAL_ATTEMPTS = 3;
export const FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT = 100;
export const FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS = 30 * 60 * 1000;
const FINDING_CONTRACT_DECISION_HISTORY_LIMIT = 20;
const FINDING_CONTRACT_DECISION_RECENT_DIGEST_LIMIT = 3;

export type FindingContractDecisionRecoveryMode = 'normal' | 'strict';
export type FindingContractDecisionStrictReason =
  | 'normal_attempts_exhausted'
  | 'evidence_or_reference_issue'
  | 'repeated_decision'
  | 'repeated_issue_set';

export interface FindingContractDecisionIssueHistoryEntry {
  readonly fingerprint: string;
  readonly occurrenceCount: number;
  readonly firstAttempt: number;
  readonly lastAttempt: number;
  readonly issues: readonly FindingContractDecisionValidationIssue[];
}

export interface FindingContractDecisionRecoveryPromptContext {
  readonly attempt: number;
  readonly maxCalls: number;
  readonly mode: FindingContractDecisionRecoveryMode;
  readonly strictReason?: FindingContractDecisionStrictReason;
  readonly latestRejection?: FindingContractRejectedDecision;
  readonly recentRejectedDecisions: readonly FindingContractRejectedDecisionDigest[];
  readonly issueHistory: readonly FindingContractDecisionIssueHistoryEntry[];
}

export interface FindingContractRejectedDecision {
  readonly attempt: number;
  readonly mode: FindingContractDecisionRecoveryMode;
  readonly issues: readonly FindingContractDecisionValidationIssue[];
  readonly issueFingerprint: string;
  readonly decisionDigest: FindingContractRejectedDecisionDigest;
  readonly repeatCount: number;
}

export interface FindingContractDecisionAttemptEvent {
  readonly type: 'started' | 'rejected' | 'accepted' | 'terminated';
  readonly attempt: number;
  readonly mode: FindingContractDecisionRecoveryMode;
  readonly strictReason?: FindingContractDecisionStrictReason;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly rejectedDecision?: FindingContractRejectedDecision;
  readonly terminationReason?: 'deadline' | 'emergency_call_limit' | 'abort' | 'provider_or_engine_error';
  readonly terminationError?: {
    readonly name: string;
    readonly message: string;
  };
}

export class FindingContractDecisionRecoveryDeadlineError extends Error {
  constructor() {
    super(`Finding Contract Team Leader decision recovery exceeded ${FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS}ms`);
    this.name = 'FindingContractDecisionRecoveryDeadlineError';
  }
}

export class FindingContractDecisionRecoveryExhaustedError extends Error {
  constructor(
    readonly lastValidationError: FindingContractTeamLeaderDecisionValidationError,
  ) {
    super(
      `Finding Contract Team Leader decision recovery exhausted `
      + `${FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT} calls: ${lastValidationError.message}`,
      { cause: lastValidationError },
    );
    this.name = 'FindingContractDecisionRecoveryExhaustedError';
  }
}

interface FindingContractDecisionRequest {
  readonly recoveryContext: FindingContractDecisionRecoveryPromptContext;
  readonly abortSignal: AbortSignal;
}

interface FindingContractDecisionRetryOptions<T> {
  readonly abortSignal?: AbortSignal;
  readonly request: (request: FindingContractDecisionRequest) => Promise<T>;
  readonly onAttempt?: (event: FindingContractDecisionAttemptEvent) => void;
}

interface RecoveryState {
  mode: FindingContractDecisionRecoveryMode;
  strictReason?: FindingContractDecisionStrictReason;
  latestRejection?: FindingContractRejectedDecision;
  recentRejectedDecisions: FindingContractRejectedDecisionDigest[];
  visibleIssueHistory: FindingContractDecisionIssueHistoryEntry[];
  issueHistoryByFingerprint: Map<string, FindingContractDecisionIssueHistoryEntry>;
  issueFingerprintCounts: Map<string, number>;
  decisionDigestCounts: Map<string, number>;
}

export async function requestValidFindingContractDecision<T>(
  options: FindingContractDecisionRetryOptions<T>,
): Promise<T> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS;
  const scope = createRecoveryAbortScope(options.abortSignal);
  const state: RecoveryState = {
    mode: 'normal',
    recentRejectedDecisions: [],
    visibleIssueHistory: [],
    issueHistoryByFingerprint: new Map(),
    issueFingerprintCounts: new Map(),
    decisionDigestCounts: new Map(),
  };

  try {
    for (let attempt = 1; attempt <= FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT; attempt++) {
      throwForRecoveryAbort(options.abortSignal, scope.signal);
      const emitTerminated = (
        terminationReason: NonNullable<FindingContractDecisionAttemptEvent['terminationReason']>,
        error: unknown,
        rejectedDecision?: FindingContractRejectedDecision,
      ): void => {
        options.onAttempt?.({
          type: 'terminated',
          attempt,
          mode: state.mode,
          ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
          ...buildAttemptTiming(startedAt, deadlineAt),
          ...(rejectedDecision === undefined ? {} : { rejectedDecision }),
          terminationReason,
          terminationError: describeTerminationError(error),
        });
      };
      if (Date.now() >= deadlineAt) {
        const deadlineError = new FindingContractDecisionRecoveryDeadlineError();
        emitTerminated('deadline', deadlineError);
        throw deadlineError;
      }
      const timing = buildAttemptTiming(startedAt, deadlineAt);
      options.onAttempt?.({
        type: 'started',
        attempt,
        mode: state.mode,
        ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
        ...timing,
      });
      try {
        const result = await waitForRequestOrAbort(
          options.request({
            recoveryContext: buildRecoveryPromptContext(attempt, state),
            abortSignal: scope.signal,
          }),
          scope.signal,
        );
        throwForRecoveryAbort(options.abortSignal, scope.signal);
        throwForRecoveryDeadline(deadlineAt);
        options.onAttempt?.({
          type: 'accepted',
          attempt,
          mode: state.mode,
          ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
          ...buildAttemptTiming(startedAt, deadlineAt),
        });
        return result;
      } catch (error) {
        if (options.abortSignal?.aborted === true) {
          emitTerminated('abort', options.abortSignal.reason);
          options.abortSignal.throwIfAborted();
        }
        if (scope.signal.aborted) {
          emitTerminated('deadline', scope.signal.reason);
          scope.signal.throwIfAborted();
        }
        if (error instanceof FindingContractDecisionRecoveryDeadlineError) {
          emitTerminated('deadline', error);
          throw error;
        }
        if (!(error instanceof FindingContractTeamLeaderDecisionValidationError)) {
          emitTerminated('provider_or_engine_error', error);
          throw error;
        }
        const rejectedDecision = recordRejectedDecision(state, attempt, error);
        options.onAttempt?.({
          type: 'rejected',
          attempt,
          mode: state.mode,
          ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
          ...buildAttemptTiming(startedAt, deadlineAt),
          rejectedDecision,
        });
        if (attempt === FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT) {
          emitTerminated('emergency_call_limit', error, rejectedDecision);
          throw new FindingContractDecisionRecoveryExhaustedError(error);
        }
        promoteRecoveryMode(state, attempt, error, rejectedDecision.repeatCount);
      }
    }
  } finally {
    scope.dispose();
  }

  throw new Error('Finding Contract Team Leader decision recovery completed without a result');
}

function recordRejectedDecision(
  state: RecoveryState,
  attempt: number,
  error: FindingContractTeamLeaderDecisionValidationError,
): FindingContractRejectedDecision {
  const issueRepeatCount = (state.issueFingerprintCounts.get(error.issueFingerprint) ?? 0) + 1;
  state.issueFingerprintCounts.set(error.issueFingerprint, issueRepeatCount);
  const digestRepeatCount = (state.decisionDigestCounts.get(error.decisionDigest.hash) ?? 0) + 1;
  state.decisionDigestCounts.set(error.decisionDigest.hash, digestRepeatCount);
  const repeatCount = Math.max(issueRepeatCount, digestRepeatCount);
  const rejectedDecision: FindingContractRejectedDecision = {
    attempt,
    mode: state.mode,
    issues: error.issues,
    issueFingerprint: error.issueFingerprint,
    decisionDigest: error.decisionDigest,
    repeatCount,
  };
  state.latestRejection = rejectedDecision;
  state.recentRejectedDecisions = [
    ...state.recentRejectedDecisions,
    error.decisionDigest,
  ].slice(-FINDING_CONTRACT_DECISION_RECENT_DIGEST_LIMIT);
  const existingHistory = state.issueHistoryByFingerprint.get(error.issueFingerprint);
  const historyEntry: FindingContractDecisionIssueHistoryEntry = existingHistory === undefined
    ? {
        fingerprint: error.issueFingerprint,
        occurrenceCount: 1,
        firstAttempt: attempt,
        lastAttempt: attempt,
        issues: error.issues,
      }
    : {
        ...existingHistory,
        occurrenceCount: issueRepeatCount,
        lastAttempt: attempt,
        issues: error.issues,
      };
  state.issueHistoryByFingerprint.set(error.issueFingerprint, historyEntry);
  state.visibleIssueHistory = [
    ...state.visibleIssueHistory.filter((entry) => entry.fingerprint !== error.issueFingerprint),
    historyEntry,
  ].slice(-FINDING_CONTRACT_DECISION_HISTORY_LIMIT);
  return rejectedDecision;
}

function promoteRecoveryMode(
  state: RecoveryState,
  attempt: number,
  error: FindingContractTeamLeaderDecisionValidationError,
  repeatCount: number,
): void {
  if (state.mode === 'strict') return;
  let strictReason: FindingContractDecisionStrictReason | undefined;
  if (hasFindingContractEvidenceOrReferenceIssue(error.issues)) {
    strictReason = 'evidence_or_reference_issue';
  } else if ((state.decisionDigestCounts.get(error.decisionDigest.hash) ?? 0) >= 2) {
    strictReason = 'repeated_decision';
  } else if (repeatCount >= 2) {
    strictReason = 'repeated_issue_set';
  } else if (attempt >= FINDING_CONTRACT_DECISION_NORMAL_ATTEMPTS) {
    strictReason = 'normal_attempts_exhausted';
  }
  if (strictReason !== undefined) {
    state.mode = 'strict';
    state.strictReason = strictReason;
  }
}

function buildRecoveryPromptContext(
  attempt: number,
  state: RecoveryState,
): FindingContractDecisionRecoveryPromptContext {
  return {
    attempt,
    maxCalls: FINDING_CONTRACT_DECISION_EMERGENCY_CALL_LIMIT,
    mode: state.mode,
    ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
    ...(state.latestRejection === undefined ? {} : { latestRejection: state.latestRejection }),
    recentRejectedDecisions: state.recentRejectedDecisions,
    issueHistory: state.visibleIssueHistory,
  };
}

function buildAttemptTiming(
  startedAt: number,
  deadlineAt: number,
): Pick<FindingContractDecisionAttemptEvent, 'elapsedMs' | 'remainingMs'> {
  const now = Date.now();
  return {
    elapsedMs: Math.max(0, now - startedAt),
    remainingMs: Math.max(0, deadlineAt - now),
  };
}

function createRecoveryAbortScope(
  parentSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const deadlineError = new FindingContractDecisionRecoveryDeadlineError();
  const timeout = setTimeout(() => controller.abort(deadlineError), FINDING_CONTRACT_DECISION_RECOVERY_DEADLINE_MS);
  timeout.unref?.();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

async function waitForRequestOrAbort<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function throwForRecoveryAbort(
  parentSignal: AbortSignal | undefined,
  recoverySignal: AbortSignal,
): void {
  parentSignal?.throwIfAborted();
  recoverySignal.throwIfAborted();
}

function throwForRecoveryDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    throw new FindingContractDecisionRecoveryDeadlineError();
  }
}

function describeTerminationError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: boundAuditText(name),
    message: boundAuditText(message),
  };
}

function boundAuditText(value: string): string {
  const maxLength = 1_000;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
