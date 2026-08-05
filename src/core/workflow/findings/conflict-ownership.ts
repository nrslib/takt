import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  computeConflictClaimSettlementId,
} from '../../models/finding-contract-identity.js';
import type {
  AdjudicatedConflictClaimSettlement,
} from '../../models/finding-contract-types.js';
import type { FindingLedger } from './types.js';

function validStandardSettlement(
  ledger: FindingLedger,
  settlement: AdjudicatedConflictClaimSettlement,
): boolean {
  const snapshot = ledger.conflictAdjudicationSnapshots.find(
    (candidate) => candidate.conflictSnapshotId === settlement.conflictSnapshotId,
  );
  const subject = snapshot?.subjects.find(
    (candidate) => candidate.subjectId === settlement.subjectId,
  );
  const attempt = ledger.conflictAdjudicationAttempts.find(
    (candidate) => candidate.attemptId === settlement.attemptId,
  );
  return settlement.settlementId === computeConflictClaimSettlementId(
    settlement.conflictId,
    settlement.subjectId,
  )
    && subject !== undefined
    && subject.conflictId === settlement.conflictId
    && subject.role === settlement.subjectRole
    && subject.findingId === settlement.findingId
    && canonicalJson(subject.expectedHead) === canonicalJson(settlement.expectedHead)
    && attempt?.stage === 'applied'
    && attempt.conflictSnapshotId === settlement.conflictSnapshotId
    && attempt.verificationDigest === settlement.verificationDigest
    && attempt.claimSettlementIds.includes(settlement.settlementId)
    && settlement.lifecycleEventIds.every((eventId) => (
      ledger.lifecycleEvents.some((event) => event.eventId === eventId)
    ));
}

export function validConflictLandingSettlements(
  ledger: FindingLedger,
  rawClaimLandingId: string,
): AdjudicatedConflictClaimSettlement[] {
  return ledger.conflictClaimSettlements.filter((settlement) => (
    settlement.rawClaimLandingIds.includes(rawClaimLandingId)
    && validStandardSettlement(ledger, settlement)
  ));
}

export function hasUnsettledActiveConflictOwnership(
  ledger: FindingLedger,
  findingId: string,
): boolean {
  const owners = new Set(ledger.conflictRawClaimLandings.flatMap((landing) => {
    if (landing.holdingFindingId !== findingId) {
      return [];
    }
    const conflict = ledger.conflicts.find((candidate) => candidate.id === landing.conflictId);
    if (
      conflict?.status !== 'active'
      || validConflictLandingSettlements(ledger, landing.rawClaimLandingId).length === 1
    ) {
      return [];
    }
    return [landing.conflictId];
  }));
  if (owners.size > 1) {
    throw new Error(
      `Conflict holding "${findingId}" has multiple unsettled active owners`,
    );
  }
  return owners.size === 1;
}
