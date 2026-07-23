import type { ProviderUsageSnapshot } from '../../models/response.js';
import {
  FindingContractControlValidationError,
  hasFindingContractEvidenceOrReferenceIssue,
  type FindingContractControlBoundaryKind,
  type FindingContractControlValidationIssue,
  type FindingContractRejectedOutputDigest,
} from '../team-leader-finding-contract-control-validation.js';

export const FINDING_CONTRACT_RECOVERY_NORMAL_ATTEMPTS = 3;
export const FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT = 100;
export const FINDING_CONTRACT_RECOVERY_DEADLINE_MS = 30 * 60 * 1000;
const FINDING_CONTRACT_RECOVERY_HISTORY_LIMIT = 20;
const FINDING_CONTRACT_RECENT_DIGEST_LIMIT = 3;

export type FindingContractRecoveryMode = 'normal' | 'strict';
export type FindingContractRecoveryStrictReason =
  | 'normal_attempts_exhausted'
  | 'evidence_or_reference_issue'
  | 'repeated_output'
  | 'repeated_issue_set';

export interface FindingContractRecoveryIssueHistoryEntry {
  readonly fingerprint: string;
  readonly occurrenceCount: number;
  readonly firstAttempt: number;
  readonly lastAttempt: number;
  readonly issues: readonly FindingContractControlValidationIssue[];
}

export interface FindingContractRejectedOutput<
  TDigest extends FindingContractRejectedOutputDigest = FindingContractRejectedOutputDigest,
> {
  readonly attempt: number;
  readonly mode: FindingContractRecoveryMode;
  readonly issues: readonly FindingContractControlValidationIssue[];
  readonly issueFingerprint: string;
  readonly outputDigest: TDigest;
  readonly repeatCount: number;
}

export interface FindingContractRecoveryPromptContext<
  TDigest extends FindingContractRejectedOutputDigest = FindingContractRejectedOutputDigest,
> {
  readonly boundaryKind: FindingContractControlBoundaryKind;
  readonly attempt: number;
  readonly maxCalls: number;
  readonly mode: FindingContractRecoveryMode;
  readonly strictReason?: FindingContractRecoveryStrictReason;
  readonly latestRejection?: FindingContractRejectedOutput<TDigest>;
  readonly recentRejectedOutputs: readonly TDigest[];
  readonly issueHistory: readonly FindingContractRecoveryIssueHistoryEntry[];
}

export interface FindingContractAttemptEnvelope<T> {
  readonly raw: T;
  readonly attemptToken: string;
  readonly sessionId?: string;
  readonly usage?: ProviderUsageSnapshot;
}

export interface FindingContractRecoveryAttemptEvent<
  TDigest extends FindingContractRejectedOutputDigest = FindingContractRejectedOutputDigest,
> {
  readonly boundaryKind: FindingContractControlBoundaryKind;
  readonly type: 'started' | 'rejected' | 'accepted' | 'terminated' | 'late';
  readonly attempt: number;
  readonly attemptToken: string;
  readonly mode: FindingContractRecoveryMode;
  readonly strictReason?: FindingContractRecoveryStrictReason;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly envelope?: FindingContractAttemptEnvelope<unknown>;
  /** Already validated value. Persist this for replay; consumers must not reparse the envelope. */
  readonly acceptedValue?: unknown;
  readonly rejectedOutput?: FindingContractRejectedOutput<TDigest>;
  readonly terminationReason?:
    | 'deadline'
    | 'emergency_call_limit'
    | 'abort'
    | 'provider_or_engine_error'
    | 'validation_terminal'
    | 'late_after_abort';
  readonly terminationError?: {
    readonly name: string;
    readonly message: string;
  };
}

export interface FindingContractRecoveryResumeState<
  TDigest extends FindingContractRejectedOutputDigest = FindingContractRejectedOutputDigest,
> {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly completedCalls: number;
  readonly mode: FindingContractRecoveryMode;
  readonly strictReason?: FindingContractRecoveryStrictReason;
  readonly latestSessionId?: string;
  readonly rejectedOutputs: readonly FindingContractRejectedOutput<TDigest>[];
}

export class FindingContractRecoveryDeadlineError extends Error {
  constructor(readonly boundaryKind: FindingContractControlBoundaryKind) {
    super(`Finding Contract ${boundaryKind} recovery exceeded ${FINDING_CONTRACT_RECOVERY_DEADLINE_MS}ms`);
    this.name = 'FindingContractRecoveryDeadlineError';
  }
}

export class FindingContractRecoveryExhaustedError extends Error {
  constructor(
    readonly boundaryKind: FindingContractControlBoundaryKind,
    readonly lastValidationError: FindingContractControlValidationError,
  ) {
    super(
      `Finding Contract ${boundaryKind} recovery exhausted `
      + `${FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT} calls: ${lastValidationError.message}`,
      { cause: lastValidationError },
    );
    this.name = 'FindingContractRecoveryExhaustedError';
  }
}

export class FindingContractRecoveryCallLimitError extends Error {
  constructor(readonly boundaryKind: FindingContractControlBoundaryKind) {
    super(
      `Finding Contract ${boundaryKind} recovery reached `
      + `${FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT} dispatched calls`,
    );
    this.name = 'FindingContractRecoveryCallLimitError';
  }
}

export interface FindingContractRecoveryRequest<
  TDigest extends FindingContractRejectedOutputDigest,
> {
  readonly recoveryContext: FindingContractRecoveryPromptContext<TDigest>;
  readonly abortSignal: AbortSignal;
  readonly attemptToken: string;
}

export interface FindingContractRecoveryAdapter<TEnvelope, TValue, TDigest extends FindingContractRejectedOutputDigest> {
  readonly boundaryKind: FindingContractControlBoundaryKind;
  readonly requestOnce: (
    request: FindingContractRecoveryRequest<TDigest>,
  ) => Promise<FindingContractAttemptEnvelope<TEnvelope>>;
  readonly validate: (envelope: FindingContractAttemptEnvelope<TEnvelope>) => TValue;
}

interface FindingContractRecoveryOptions<TEnvelope, TValue, TDigest extends FindingContractRejectedOutputDigest> {
  readonly adapter: FindingContractRecoveryAdapter<TEnvelope, TValue, TDigest>;
  readonly abortSignal?: AbortSignal;
  readonly initialValidationError?: FindingContractControlValidationError<TDigest>;
  readonly initialEnvelope?: FindingContractAttemptEnvelope<TEnvelope>;
  readonly resumeState?: FindingContractRecoveryResumeState<TDigest>;
  readonly onAttempt?: (event: FindingContractRecoveryAttemptEvent<TDigest>) => void;
}

interface RecoveryState<TDigest extends FindingContractRejectedOutputDigest> {
  mode: FindingContractRecoveryMode;
  strictReason?: FindingContractRecoveryStrictReason;
  latestRejection?: FindingContractRejectedOutput<TDigest>;
  recentRejectedOutputs: TDigest[];
  visibleIssueHistory: FindingContractRecoveryIssueHistoryEntry[];
  issueHistoryByFingerprint: Map<string, FindingContractRecoveryIssueHistoryEntry>;
  issueFingerprintCounts: Map<string, number>;
  outputDigestCounts: Map<string, number>;
}

export async function requestValidFindingContractControlOutput<
  TEnvelope,
  TValue,
  TDigest extends FindingContractRejectedOutputDigest,
>(
  options: FindingContractRecoveryOptions<TEnvelope, TValue, TDigest>,
): Promise<TValue> {
  const startedAt = options.resumeState?.startedAt ?? Date.now();
  const deadlineAt = options.resumeState?.deadlineAt
    ?? startedAt + FINDING_CONTRACT_RECOVERY_DEADLINE_MS;
  const scope = createRecoveryAbortScope(
    options.abortSignal,
    options.adapter.boundaryKind,
    deadlineAt,
  );
  const state: RecoveryState<TDigest> = {
    mode: options.resumeState?.mode ?? 'normal',
    ...(options.resumeState?.strictReason === undefined
      ? {}
      : { strictReason: options.resumeState.strictReason }),
    recentRejectedOutputs: [],
    visibleIssueHistory: [],
    issueHistoryByFingerprint: new Map(),
    issueFingerprintCounts: new Map(),
    outputDigestCounts: new Map(),
  };
  for (const rejectedOutput of options.resumeState?.rejectedOutputs ?? []) {
    restoreRejectedOutput(state, rejectedOutput);
  }
  if (options.initialValidationError !== undefined) {
    if (options.initialValidationError.retryability === 'terminal') {
      emitTerminated(
        options,
        state,
        0,
        `${options.adapter.boundaryKind}:initial`,
        startedAt,
        deadlineAt,
        'validation_terminal',
        options.initialValidationError,
        options.initialEnvelope,
      );
      throw options.initialValidationError;
    }
    if (!(options.resumeState?.rejectedOutputs.some((rejection) => rejection.attempt === 0) ?? false)) {
      const rejection = recordRejectedOutput(state, 0, options.initialValidationError);
      promoteRecoveryMode(state, 0, options.initialValidationError, rejection.repeatCount);
      options.onAttempt?.({
        boundaryKind: options.adapter.boundaryKind,
        type: 'rejected',
        attempt: 0,
        attemptToken: `${options.adapter.boundaryKind}:initial`,
        mode: state.mode,
        ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
        ...buildAttemptTiming(startedAt, deadlineAt),
        ...(options.initialEnvelope === undefined ? {} : { envelope: options.initialEnvelope }),
        rejectedOutput: rejection,
      });
    }
  }

  try {
    const firstAttempt = (options.resumeState?.completedCalls ?? 0) + 1;
    if (firstAttempt > FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT) {
      const error = new FindingContractRecoveryCallLimitError(options.adapter.boundaryKind);
      emitTerminated(
        options,
        state,
        FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT,
        `${options.adapter.boundaryKind}:resume-limit`,
        startedAt,
        deadlineAt,
        'emergency_call_limit',
        error,
      );
      throw error;
    }
    for (
      let attempt = firstAttempt;
      attempt <= FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT;
      attempt++
    ) {
      throwForRecoveryAbort(options.abortSignal, scope.signal);
      const attemptToken = `${options.adapter.boundaryKind}:${attempt}`;
      if (Date.now() >= deadlineAt) {
        const error = new FindingContractRecoveryDeadlineError(options.adapter.boundaryKind);
        emitTerminated(options, state, attempt, attemptToken, startedAt, deadlineAt, 'deadline', error);
        throw error;
      }
      options.onAttempt?.({
        boundaryKind: options.adapter.boundaryKind,
        type: 'started',
        attempt,
        attemptToken,
        mode: state.mode,
        ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
        ...buildAttemptTiming(startedAt, deadlineAt),
      });
      let envelope: FindingContractAttemptEnvelope<TEnvelope> | undefined;
      try {
        envelope = await waitForRequestOrAbort(
          options.adapter.requestOnce({
            recoveryContext: buildRecoveryPromptContext(options.adapter.boundaryKind, attempt, state),
            abortSignal: scope.signal,
            attemptToken,
          }),
          scope.signal,
          (lateEnvelope) => {
            options.onAttempt?.({
              boundaryKind: options.adapter.boundaryKind,
              type: 'late',
              attempt,
              attemptToken,
              mode: state.mode,
              ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
              ...buildAttemptTiming(startedAt, deadlineAt),
              envelope: lateEnvelope,
              terminationReason: 'late_after_abort',
            });
          },
        );
        throwForRecoveryAbort(options.abortSignal, scope.signal);
        throwForRecoveryDeadline(deadlineAt, options.adapter.boundaryKind);
        const value = options.adapter.validate(envelope);
        options.onAttempt?.({
          boundaryKind: options.adapter.boundaryKind,
          type: 'accepted',
          attempt,
          attemptToken,
          mode: state.mode,
          ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
          ...buildAttemptTiming(startedAt, deadlineAt),
          envelope,
          acceptedValue: value,
        });
        return value;
      } catch (error) {
        if (options.abortSignal?.aborted === true) {
          emitTerminated(options, state, attempt, attemptToken, startedAt, deadlineAt, 'abort', options.abortSignal.reason, envelope);
          options.abortSignal.throwIfAborted();
        }
        if (scope.signal.aborted) {
          emitTerminated(options, state, attempt, attemptToken, startedAt, deadlineAt, 'deadline', scope.signal.reason, envelope);
          scope.signal.throwIfAborted();
        }
        if (!(error instanceof FindingContractControlValidationError)) {
          emitTerminated(
            options,
            state,
            attempt,
            attemptToken,
            startedAt,
            deadlineAt,
            error instanceof FindingContractRecoveryDeadlineError ? 'deadline' : 'provider_or_engine_error',
            error,
            envelope,
          );
          throw error;
        }
        if (error.retryability === 'terminal') {
          emitTerminated(
            options,
            state,
            attempt,
            attemptToken,
            startedAt,
            deadlineAt,
            'validation_terminal',
            error,
            envelope,
          );
          throw error;
        }
        const rejectedOutput = recordRejectedOutput(state, attempt, error as FindingContractControlValidationError<TDigest>);
        promoteRecoveryMode(state, attempt, error, rejectedOutput.repeatCount);
        options.onAttempt?.({
          boundaryKind: options.adapter.boundaryKind,
          type: 'rejected',
          attempt,
          attemptToken,
          mode: state.mode,
          ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
          ...buildAttemptTiming(startedAt, deadlineAt),
          ...(envelope === undefined ? {} : { envelope }),
          rejectedOutput,
        });
        if (attempt === FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT) {
          const exhausted = new FindingContractRecoveryExhaustedError(options.adapter.boundaryKind, error);
          emitTerminated(
            options,
            state,
            attempt,
            attemptToken,
            startedAt,
            deadlineAt,
            'emergency_call_limit',
            exhausted,
            envelope,
            rejectedOutput,
          );
          throw exhausted;
        }
      }
    }
  } finally {
    scope.dispose();
  }

  throw new Error(`Finding Contract ${options.adapter.boundaryKind} recovery completed without a result`);
}

function restoreRejectedOutput<TDigest extends FindingContractRejectedOutputDigest>(
  state: RecoveryState<TDigest>,
  rejectedOutput: FindingContractRejectedOutput<TDigest>,
): void {
  const issueCount = (state.issueFingerprintCounts.get(rejectedOutput.issueFingerprint) ?? 0) + 1;
  state.issueFingerprintCounts.set(rejectedOutput.issueFingerprint, issueCount);
  const digestCount = (state.outputDigestCounts.get(rejectedOutput.outputDigest.hash) ?? 0) + 1;
  state.outputDigestCounts.set(rejectedOutput.outputDigest.hash, digestCount);
  state.latestRejection = rejectedOutput;
  state.recentRejectedOutputs = [...state.recentRejectedOutputs, rejectedOutput.outputDigest]
    .slice(-FINDING_CONTRACT_RECENT_DIGEST_LIMIT);
  const existing = state.issueHistoryByFingerprint.get(rejectedOutput.issueFingerprint);
  const history: FindingContractRecoveryIssueHistoryEntry = existing === undefined
    ? {
        fingerprint: rejectedOutput.issueFingerprint,
        occurrenceCount: 1,
        firstAttempt: rejectedOutput.attempt,
        lastAttempt: rejectedOutput.attempt,
        issues: rejectedOutput.issues,
      }
    : {
        ...existing,
        occurrenceCount: issueCount,
        lastAttempt: rejectedOutput.attempt,
        issues: rejectedOutput.issues,
      };
  state.issueHistoryByFingerprint.set(rejectedOutput.issueFingerprint, history);
  state.visibleIssueHistory = [
    ...state.visibleIssueHistory.filter(
      (entry) => entry.fingerprint !== rejectedOutput.issueFingerprint,
    ),
    history,
  ].slice(-FINDING_CONTRACT_RECOVERY_HISTORY_LIMIT);
}

function recordRejectedOutput<TDigest extends FindingContractRejectedOutputDigest>(
  state: RecoveryState<TDigest>,
  attempt: number,
  error: FindingContractControlValidationError<TDigest>,
): FindingContractRejectedOutput<TDigest> {
  const issueRepeatCount = (state.issueFingerprintCounts.get(error.issueFingerprint) ?? 0) + 1;
  state.issueFingerprintCounts.set(error.issueFingerprint, issueRepeatCount);
  const digestRepeatCount = (state.outputDigestCounts.get(error.outputDigest.hash) ?? 0) + 1;
  state.outputDigestCounts.set(error.outputDigest.hash, digestRepeatCount);
  const rejectedOutput: FindingContractRejectedOutput<TDigest> = {
    attempt,
    mode: state.mode,
    issues: error.issues,
    issueFingerprint: error.issueFingerprint,
    outputDigest: error.outputDigest,
    repeatCount: Math.max(issueRepeatCount, digestRepeatCount),
  };
  state.latestRejection = rejectedOutput;
  state.recentRejectedOutputs = [...state.recentRejectedOutputs, error.outputDigest]
    .slice(-FINDING_CONTRACT_RECENT_DIGEST_LIMIT);
  const existing = state.issueHistoryByFingerprint.get(error.issueFingerprint);
  const history: FindingContractRecoveryIssueHistoryEntry = existing === undefined
    ? {
        fingerprint: error.issueFingerprint,
        occurrenceCount: 1,
        firstAttempt: attempt,
        lastAttempt: attempt,
        issues: error.issues,
      }
    : {
        ...existing,
        occurrenceCount: issueRepeatCount,
        lastAttempt: attempt,
        issues: error.issues,
      };
  state.issueHistoryByFingerprint.set(error.issueFingerprint, history);
  state.visibleIssueHistory = [
    ...state.visibleIssueHistory.filter((entry) => entry.fingerprint !== error.issueFingerprint),
    history,
  ].slice(-FINDING_CONTRACT_RECOVERY_HISTORY_LIMIT);
  return rejectedOutput;
}

function promoteRecoveryMode<TDigest extends FindingContractRejectedOutputDigest>(
  state: RecoveryState<TDigest>,
  attempt: number,
  error: FindingContractControlValidationError<TDigest>,
  repeatCount: number,
): void {
  if (state.mode === 'strict') return;
  let strictReason: FindingContractRecoveryStrictReason | undefined;
  if (hasFindingContractEvidenceOrReferenceIssue(error.issues)) {
    strictReason = 'evidence_or_reference_issue';
  } else if ((state.outputDigestCounts.get(error.outputDigest.hash) ?? 0) >= 2) {
    strictReason = 'repeated_output';
  } else if (repeatCount >= 2) {
    strictReason = 'repeated_issue_set';
  } else if (attempt >= FINDING_CONTRACT_RECOVERY_NORMAL_ATTEMPTS) {
    strictReason = 'normal_attempts_exhausted';
  }
  if (strictReason !== undefined) {
    state.mode = 'strict';
    state.strictReason = strictReason;
  }
}

function buildRecoveryPromptContext<TDigest extends FindingContractRejectedOutputDigest>(
  boundaryKind: FindingContractControlBoundaryKind,
  attempt: number,
  state: RecoveryState<TDigest>,
): FindingContractRecoveryPromptContext<TDigest> {
  return {
    boundaryKind,
    attempt,
    maxCalls: FINDING_CONTRACT_RECOVERY_EMERGENCY_CALL_LIMIT,
    mode: state.mode,
    ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
    ...(state.latestRejection === undefined ? {} : { latestRejection: state.latestRejection }),
    recentRejectedOutputs: state.recentRejectedOutputs,
    issueHistory: state.visibleIssueHistory,
  };
}

function emitTerminated<TEnvelope, TValue, TDigest extends FindingContractRejectedOutputDigest>(
  options: FindingContractRecoveryOptions<TEnvelope, TValue, TDigest>,
  state: RecoveryState<TDigest>,
  attempt: number,
  attemptToken: string,
  startedAt: number,
  deadlineAt: number,
  terminationReason: NonNullable<FindingContractRecoveryAttemptEvent['terminationReason']>,
  error: unknown,
  envelope?: FindingContractAttemptEnvelope<TEnvelope>,
  rejectedOutput?: FindingContractRejectedOutput<TDigest>,
): void {
  options.onAttempt?.({
    boundaryKind: options.adapter.boundaryKind,
    type: 'terminated',
    attempt,
    attemptToken,
    mode: state.mode,
    ...(state.strictReason === undefined ? {} : { strictReason: state.strictReason }),
    ...buildAttemptTiming(startedAt, deadlineAt),
    ...(envelope === undefined ? {} : { envelope }),
    ...(rejectedOutput === undefined ? {} : { rejectedOutput }),
    terminationReason,
    terminationError: describeTerminationError(error),
  });
}

function buildAttemptTiming(
  startedAt: number,
  deadlineAt: number,
): Pick<FindingContractRecoveryAttemptEvent, 'elapsedMs' | 'remainingMs'> {
  const now = Date.now();
  return {
    elapsedMs: Math.max(0, now - startedAt),
    remainingMs: Math.max(0, deadlineAt - now),
  };
}

function createRecoveryAbortScope(
  parentSignal: AbortSignal | undefined,
  boundaryKind: FindingContractControlBoundaryKind,
  deadlineAt: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  const deadline = setTimeout(() => {
    controller.abort(new FindingContractRecoveryDeadlineError(boundaryKind));
  }, remainingMs);
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(deadline);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

function throwForRecoveryAbort(parentSignal: AbortSignal | undefined, scopeSignal: AbortSignal): void {
  parentSignal?.throwIfAborted();
  scopeSignal.throwIfAborted();
}

function throwForRecoveryDeadline(
  deadlineAt: number,
  boundaryKind: FindingContractControlBoundaryKind,
): void {
  if (Date.now() >= deadlineAt) {
    throw new FindingContractRecoveryDeadlineError(boundaryKind);
  }
}

async function waitForRequestOrAbort<T>(
  request: Promise<T>,
  signal: AbortSignal,
  onLateResolve: (value: T) => void,
): Promise<T> {
  if (signal.aborted) signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(
      (value) => {
        if (settled) {
          onLateResolve(value);
          return;
        }
        settle(() => resolve(value));
      },
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function describeTerminationError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}
