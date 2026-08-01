import {
  buildAdjudicationEvidenceSnapshot,
  computeAdjudicationEvidenceHash,
  isConflictUnadjudicated,
} from './adjudication-evidence.js';
import type { AdjudicationEvidenceSnapshot } from './adjudication-evidence.js';
import { captureReviewScopeSnapshot } from './snapshot.js';
import type {
  FindingLedger,
  FindingLifecycleReservation,
  FindingObservation,
} from './types.js';
import type { FindingAdjudicationStore, FindingLedgerMutation } from './store.js';
import { reserveFindingConflictAdjudicationLifecycle } from './lifecycle-transaction.js';
import { findingLifecycleReservationMatchesCurrentHeads } from './lifecycle-mutation.js';

export type AdjudicationAttemptReservation =
  | { started: false }
  | {
    started: true;
    evidenceHash: string;
    evidenceSnapshot: AdjudicationEvidenceSnapshot;
    originStep: string | undefined;
    reservationToken: string;
  };

type PendingFindingConflictAdjudication = FindingLifecycleReservation & {
  context: Extract<
    FindingLifecycleReservation['context'],
    { kind: 'conflict_adjudication' }
  >;
};

function pendingFindingConflictAdjudications(input: {
  ledger: FindingLedger;
  conflictId: string;
  evidenceHash: string;
}): PendingFindingConflictAdjudication[] {
  const appliedMutationIds = new Set(
    input.ledger.lifecycleEvents.map((event) => event.mutationId),
  );
  return input.ledger.lifecycleReservations.filter(
    (reservation): reservation is PendingFindingConflictAdjudication => (
      reservation.context.kind === 'conflict_adjudication'
      && reservation.context.conflictId === input.conflictId
      && reservation.context.evidenceHash === input.evidenceHash
      && !appliedMutationIds.has(reservation.mutationId)
    ),
  );
}

export function findPendingFindingConflictAdjudication(input: {
  ledger: FindingLedger;
  conflictId: string;
  evidenceHash: string;
}): FindingLifecycleReservation | undefined {
  return pendingFindingConflictAdjudications(input).find((reservation) => (
    findingLifecycleReservationMatchesCurrentHeads(input.ledger, reservation)
  ));
}

export async function reserveFindingConflictAdjudication(input: {
  ledgerStore: FindingAdjudicationStore;
  conflictId: string;
  requestedOriginStep: string | undefined;
  runId: string;
  observation: FindingObservation;
  cwd: string;
}): Promise<FindingLedgerMutation<AdjudicationAttemptReservation>> {
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
    const pending = findPendingFindingConflictAdjudication({
      ledger: fresh,
      conflictId: freshConflict.id,
      evidenceHash: freshHash,
    });
    if (pending !== undefined) {
      const context = pending.context;
      if (context.kind !== 'conflict_adjudication') {
        throw new Error(
          `Lifecycle reservation "${pending.mutationId}" has an invalid adjudication context`,
        );
      }
      return {
        ledger: fresh,
        result: {
          started: true as const,
          evidenceHash: freshHash,
          evidenceSnapshot,
          originStep: context.originStep ?? undefined,
          reservationToken: pending.mutationId,
        },
      };
    }
    if (!isConflictUnadjudicated(freshConflict, freshHash)) {
      return { ledger: fresh, result: { started: false as const } };
    }
    const previousPending = pendingFindingConflictAdjudications({
      ledger: fresh,
      conflictId: freshConflict.id,
      evidenceHash: freshHash,
    })[0];
    const originStep = previousPending === undefined
      ? input.requestedOriginStep ?? null
      : previousPending.context.originStep;
    const reserved = reserveFindingConflictAdjudicationLifecycle({
      ledger: fresh,
      conflictId: freshConflict.id,
      evidenceHash: freshHash,
      originStep,
      reservedAt: input.observation,
    });
    return {
      ledger: reserved.ledger,
      result: {
        started: true as const,
        evidenceHash: freshHash,
        evidenceSnapshot,
        originStep: originStep ?? undefined,
        reservationToken: reserved.mutationId,
      },
    };
  });
}
