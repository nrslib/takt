import { randomUUID } from 'node:crypto';
import {
  buildAdjudicationEvidenceSnapshot,
  computeAdjudicationEvidenceHash,
  findReusablePendingAttempt,
  isConflictUnadjudicated,
} from './adjudication-evidence.js';
import type { AdjudicationEvidenceSnapshot } from './adjudication-evidence.js';
import { captureReviewScopeSnapshot } from './snapshot.js';
import type { FindingObservation } from './types.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';

export type AdjudicationAttemptReservation =
  | { started: false }
  | {
    started: true;
    evidenceHash: string;
    evidenceSnapshot: AdjudicationEvidenceSnapshot;
    originStep: string | undefined;
    reservationToken: string;
  };

export async function reserveFindingConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  conflictId: string;
  requestedOriginStep: string | undefined;
  runId: string;
  observation: FindingObservation;
  cwd: string;
}): Promise<FindingLedgerMutation<AdjudicationAttemptReservation>> {
  const proposedReservationToken = randomUUID();
  return input.ledgerStore.updateLedger<AdjudicationAttemptReservation>((fresh) => {
    const freshConflict = fresh.conflicts.find((conflict) => conflict.id === input.conflictId);
    if (freshConflict === undefined || freshConflict.status !== 'active') {
      return { ledger: fresh, result: { started: false as const } };
    }
    const reviewScopeSnapshot = captureReviewScopeSnapshot(input.cwd);
    const evidenceSnapshot = buildAdjudicationEvidenceSnapshot({
      ledger: fresh,
      conflictId: freshConflict.id,
      reviewScopeSnapshot,
    });
    const freshHash = computeAdjudicationEvidenceHash(evidenceSnapshot);
    const reusableAttempt = findReusablePendingAttempt(freshConflict, freshHash, input.runId);
    if (reusableAttempt !== undefined) {
      return {
        ledger: fresh,
        result: {
          started: true as const,
          evidenceHash: freshHash,
          evidenceSnapshot,
          originStep: input.requestedOriginStep ?? reusableAttempt.originStep,
          reservationToken: reusableAttempt.reservationToken,
        },
      };
    }
    if (!isConflictUnadjudicated(freshConflict, freshHash)) {
      return { ledger: fresh, result: { started: false as const } };
    }
    const pendingWithOrigin = [...(freshConflict.adjudicationAttempts ?? [])]
      .reverse()
      .find((attempt) => (
        attempt.originStep !== undefined
        && !(freshConflict.adjudications ?? []).some((record) => record.evidenceHash === attempt.evidenceHash)
      ));
    const originStep = input.requestedOriginStep ?? pendingWithOrigin?.originStep;
    return {
      ledger: {
        ...fresh,
        conflicts: fresh.conflicts.map((conflict) => (conflict.id === freshConflict.id
          ? {
            ...conflict,
            adjudicationAttempts: [
              ...(conflict.adjudicationAttempts ?? []),
              {
                evidenceHash: freshHash,
                reservationToken: proposedReservationToken,
                startedAt: input.observation,
                ...(originStep !== undefined ? { originStep } : {}),
              },
            ],
          }
          : conflict)),
      },
      result: {
        started: true as const,
        evidenceHash: freshHash,
        evidenceSnapshot,
        originStep,
        reservationToken: proposedReservationToken,
      },
    };
  });
}
