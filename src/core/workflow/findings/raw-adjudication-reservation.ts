import { classifyProvisionalRecovery, isOpenProvisional } from './provisional-recovery.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import type { FindingManagerStore, FindingLedgerMutation } from './store.js';

export interface RawAdjudicationReservation {
  provisionalFindingId: string;
  expectedRevision: number;
  attempt: number;
  reservationToken: string;
}

function rawAdjudicationReservationToken(input: {
  provisionalFindingId: string;
  expectedRevision: number;
  attempt: number;
}): string {
  return `raw-adjudication:${input.provisionalFindingId}:${input.expectedRevision}:${input.attempt}`;
}

export async function reserveRawAdjudicationRecovery(
  store: FindingManagerStore,
): Promise<FindingLedgerMutation<RawAdjudicationReservation[]>> {
  const snapshot = store.loadLedger();
  const snapshotRoundsCompleted = stopBudgetRoundsCompleted(snapshot);
  const hasCandidate = snapshot.findings.some((finding) => (
    isOpenProvisional(finding)
    && classifyProvisionalRecovery(finding.provisional, snapshotRoundsCompleted) === 'raw-adjudication'
  ));
  if (!hasCandidate) {
    return { ledger: snapshot, result: [] };
  }
  const claimedTokens = new Set<string>();
  try {
    return await store.updateLedger((ledger) => {
      const roundsCompleted = stopBudgetRoundsCompleted(ledger);
      const reservations = ledger.findings.flatMap((finding): RawAdjudicationReservation[] => {
        if (!isOpenProvisional(finding)
          || classifyProvisionalRecovery(finding.provisional, roundsCompleted) !== 'raw-adjudication') {
          return [];
        }
        const expectedRevision = finding.revision ?? 1;
        const attempt = (finding.provisional.adjudicationAttempts ?? []).length + 1;
        const reservationToken = rawAdjudicationReservationToken({
          provisionalFindingId: finding.id,
          expectedRevision,
          attempt,
        });
        if (!store.claimAdjudicationReservation(reservationToken)) {
          return [];
        }
        claimedTokens.add(reservationToken);
        return [{
          provisionalFindingId: finding.id,
          expectedRevision,
          attempt,
          reservationToken,
        }];
      });
      return { ledger, result: reservations };
    });
  } catch (error) {
    for (const reservationToken of claimedTokens) {
      store.releaseAdjudicationReservation(reservationToken);
    }
    throw error;
  }
}

export function releaseRawAdjudicationReservations(
  store: FindingManagerStore,
  reservationTokens: ReadonlySet<string>,
): void {
  for (const reservationToken of reservationTokens) {
    store.releaseAdjudicationReservation(reservationToken);
  }
}
