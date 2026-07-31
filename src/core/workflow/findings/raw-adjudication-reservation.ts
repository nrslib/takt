import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  createRawRecoveryAttempt,
  createRawRecoveryResult,
} from '../../models/finding-raw-recovery.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import {
  classifyProvisionalRecovery,
  isOpenProvisional,
  provisionalRecoveryAttemptCount,
} from './provisional-recovery.js';
import {
  compareRawAdjudicationCandidates,
  type RawAdjudicationCandidate,
} from './raw-adjudication-priority.js';
import { RAW_ADJUDICATION_RECOVERY_LIMITS } from './raw-finding-limits.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import type { FindingManagerStore, FindingLedgerMutation } from './store.js';
import {
  snapshotProvisionalRecoveryOrigin,
  type ProvisionalRecoveryOrigin,
} from './provisional-recovery-origin.js';
import type { FindingLifecycleEntityHead, FindingObservation } from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';

export interface RawAdjudicationReservation {
  attemptId: string;
  provisionalFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  expectedRevision: number;
  attempt: number;
  sourceRawFindingId: string;
  sourceRawIntegrityDigest: string | null;
  reservationToken: string;
  recoveryOrigin: ProvisionalRecoveryOrigin;
}

function promptSnapshotDigest(input: {
  recoveryOrigin: ProvisionalRecoveryOrigin;
  sourceRawFindingId: string;
  sourceRawIntegrityDigest: string | null;
  reviewScopeSnapshotId: string;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export async function reserveRawAdjudicationRecovery(
  store: FindingManagerStore,
  observation: FindingObservation,
  reviewScopeSnapshotId: string,
): Promise<FindingLedgerMutation<RawAdjudicationReservation[]>> {
  const snapshot = store.loadLedger();
  const snapshotRoundsCompleted = stopBudgetRoundsCompleted(snapshot);
  const hasPendingAttempt = (ledger: typeof snapshot, findingId: string): boolean => (
    ledger.rawRecoveryAttempts.some((attempt) => (
      attempt.provisionalFindingId === findingId
      && !ledger.rawRecoveryResults.some((result) => result.attemptId === attempt.attemptId)
    ))
  );
  const hasCandidate = snapshot.findings.some((finding) => (
    isOpenProvisional(finding)
    && (
      hasPendingAttempt(snapshot, finding.id)
      || classifyProvisionalRecovery(
        finding.provisional,
        snapshotRoundsCompleted,
        provisionalRecoveryAttemptCount(snapshot, finding.id),
      ) === 'raw-adjudication'
    )
  ));
  if (!hasCandidate) {
    return { ledger: snapshot, result: [] };
  }
  return store.updateLedger((ledger) => {
      const rawRecoveryAttempts = [...ledger.rawRecoveryAttempts];
      const rawRecoveryResults = [...ledger.rawRecoveryResults];
      const completedAttemptIds = new Set(
        rawRecoveryResults.map((result) => result.attemptId),
      );
      for (const attempt of rawRecoveryAttempts) {
        if (completedAttemptIds.has(attempt.attemptId)) {
          continue;
        }
        const currentHead = captureFindingLifecycleHead(
          ledger,
          'finding',
          attempt.provisionalFindingId,
        );
        if (
          currentHead !== undefined
          && currentHead.revision === attempt.expectedHead.revision
          && currentHead.eventId === attempt.expectedHead.eventId
          && currentHead.projectionDigest === attempt.expectedHead.projectionDigest
        ) {
          continue;
        }
        rawRecoveryResults.push(createRawRecoveryResult({
          attemptId: attempt.attemptId,
          replayRawFindingId: null,
          mutationIds: [],
          outcome: 'stale',
          completedAt: observation,
        }));
        completedAttemptIds.add(attempt.attemptId);
      }
      const selectionLedger = { ...ledger, rawRecoveryResults };
      const roundsCompleted = stopBudgetRoundsCompleted(ledger);
      const candidates = ledger.findings
        .filter((finding): finding is RawAdjudicationCandidate => (
          isOpenProvisional(finding)
          && (
            hasPendingAttempt(selectionLedger, finding.id)
            || classifyProvisionalRecovery(
              finding.provisional,
              roundsCompleted,
              provisionalRecoveryAttemptCount(selectionLedger, finding.id),
            ) === 'raw-adjudication'
          )
        ))
        .sort((left, right) => (
          Number(hasPendingAttempt(selectionLedger, right.id))
          - Number(hasPendingAttempt(selectionLedger, left.id))
          || provisionalRecoveryAttemptCount(selectionLedger, left.id)
          - provisionalRecoveryAttemptCount(selectionLedger, right.id)
          || compareRawAdjudicationCandidates(left, right)
        ));
      const reservations: RawAdjudicationReservation[] = [];
      for (const finding of candidates) {
        if (reservations.length >= RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayTargetsPerStep) {
          break;
        }
        const expectedRevision = finding.revision;
        const recoveryOrigin = snapshotProvisionalRecoveryOrigin(finding);
        const expectedHead = captureFindingLifecycleHead(ledger, 'finding', finding.id);
        if (expectedHead === undefined) {
          throw new Error(`Raw recovery candidate "${finding.id}" has no lifecycle head`);
        }
        const existing = rawRecoveryAttempts.find((candidate) => (
          candidate.provisionalFindingId === finding.id
          && candidate.expectedHead.eventId === expectedHead.eventId
          && !rawRecoveryResults.some((result) => (
            result.attemptId === candidate.attemptId
          ))
        ));
        const attempt = existing?.attempt ?? (
          Math.max(
            0,
            ...rawRecoveryAttempts
              .filter((candidate) => candidate.provisionalFindingId === finding.id)
              .map((candidate) => candidate.attempt),
          ) + 1
        );
        const sourceRawFindingId = finding.provisional.sourceRawFindingIds.length === 0
          ? `raw-adjudication:${finding.id}:${attempt}:missing-source`
          : finding.provisional.sourceRawFindingIds[
            (attempt - 1) % finding.provisional.sourceRawFindingIds.length
          ]!;
        const sourceRaw = ledger.rawFindings.find((raw) => raw.rawFindingId === sourceRawFindingId);
        const sourceRawIntegrityDigest = sourceRaw === undefined
          ? null
          : computeRawFindingIntegrityDigest(sourceRaw);
        const durableAttempt = existing ?? createRawRecoveryAttempt({
          provisionalFindingId: finding.id,
          expectedHead,
          sourceRawFindingId,
          sourceRawIntegrityDigest,
          promptSnapshotDigest: promptSnapshotDigest({
            recoveryOrigin,
            sourceRawFindingId,
            sourceRawIntegrityDigest,
            reviewScopeSnapshotId,
          }),
          attempt,
          startedAt: observation,
        });
        if (existing === undefined) {
          rawRecoveryAttempts.push(durableAttempt);
        }
        reservations.push({
          attemptId: durableAttempt.attemptId,
          provisionalFindingId: finding.id,
          expectedHead,
          expectedRevision,
          attempt,
          sourceRawFindingId,
          sourceRawIntegrityDigest: durableAttempt.sourceRawIntegrityDigest,
          reservationToken: durableAttempt.attemptId,
          recoveryOrigin,
        });
      }
      return {
        ledger: { ...ledger, rawRecoveryAttempts, rawRecoveryResults },
        result: reservations,
      };
    });
}

export function releaseRawAdjudicationReservations(
  _store: FindingManagerStore,
  _reservationTokens: ReadonlySet<string>,
): void {
  // Durable raw recovery attempts are completed by the commit transaction.
}
