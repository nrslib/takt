import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  FindingLifecycleEntityHead,
  FindingObservation,
  RawRecoveryAttempt,
  RawRecoveryResult,
} from './finding-types.js';

function contentAddress(domain: string, payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain, payload }))
    .digest('hex');
}

export function createRawRecoveryAttempt(input: {
  provisionalFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  sourceRawFindingId: string;
  sourceRawIntegrityDigest: string | null;
  promptSnapshotDigest: string;
  attempt: number;
  startedAt: FindingObservation;
}): RawRecoveryAttempt {
  const identity = {
    provisionalFindingId: input.provisionalFindingId,
    expectedHead: structuredClone(input.expectedHead),
    sourceRawFindingId: input.sourceRawFindingId,
    sourceRawIntegrityDigest: input.sourceRawIntegrityDigest,
    promptSnapshotDigest: input.promptSnapshotDigest,
    attempt: input.attempt,
  };
  return {
    attemptId: contentAddress('finding-raw-recovery-attempt', identity),
    ...identity,
    startedAt: structuredClone(input.startedAt),
  };
}

export function createRawRecoveryResult(input: {
  attemptId: string;
  replayRawFindingId: string | null;
  mutationIds: readonly string[];
  outcome: RawRecoveryResult['outcome'];
  completedAt: FindingObservation;
}): RawRecoveryResult {
  if (new Set(input.mutationIds).size !== input.mutationIds.length) {
    throw new Error('Raw recovery result mutation ids must be unique');
  }
  const identity = {
    attemptId: input.attemptId,
    replayRawFindingId: input.replayRawFindingId,
    mutationIds: [...input.mutationIds],
    outcome: input.outcome,
  };
  return {
    resultId: contentAddress('finding-raw-recovery-result', identity),
    ...identity,
    completedAt: structuredClone(input.completedAt),
  };
}

export function rawRecoveryAttemptIdentityViolation(
  attempt: RawRecoveryAttempt,
): string | undefined {
  const canonical = createRawRecoveryAttempt(attempt);
  return canonical.attemptId === attempt.attemptId
    ? undefined
    : `Raw recovery attempt "${attempt.attemptId}" has an invalid content address`;
}

export function rawRecoveryResultIdentityViolation(
  result: RawRecoveryResult,
): string | undefined {
  const canonical = createRawRecoveryResult(result);
  return canonical.resultId === result.resultId
    ? undefined
    : `Raw recovery result "${result.resultId}" has an invalid content address`;
}
