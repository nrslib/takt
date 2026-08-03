import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  computeConflictClaimSettlementId,
  computeProvisionalConflictNormalizationSettlementId,
} from '../../models/finding-contract-identity.js';
import type {
  AdjudicatedConflictClaimSettlement,
  ProvisionalConflictNormalizationSettlement,
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

function validNormalizationSettlement(
  ledger: FindingLedger,
  settlement: ProvisionalConflictNormalizationSettlement,
): boolean {
  const snapshot = ledger.provisionalConflictNormalizationSnapshots.find(
    (candidate) => candidate.normalizationSnapshotId === settlement.normalizationSnapshotId,
  );
  const subject = snapshot?.subjects.find(
    (candidate) => candidate.subjectId === settlement.subjectId,
  );
  const record = ledger.provisionalConflictNormalizations.find(
    (candidate) => candidate.normalizationId === settlement.normalizationId,
  );
  const decision = record?.decisions.find(
    (candidate) => candidate.subjectId === settlement.subjectId,
  );
  const event = ledger.lifecycleEvents.find(
    (candidate) => candidate.eventId === settlement.lifecycleEventIds[0],
  );
  return settlement.settlementId === computeProvisionalConflictNormalizationSettlementId({
    normalizationId: settlement.normalizationId,
    conflictId: settlement.conflictId,
    subjectId: settlement.subjectId,
  })
    && subject !== undefined
    && subject.conflictId === settlement.conflictId
    && subject.role === settlement.subjectRole
    && subject.findingId === settlement.findingId
    && canonicalJson(subject.expectedHead) === canonicalJson(settlement.expectedHead)
    && record?.normalizationSnapshotId === settlement.normalizationSnapshotId
    && decision?.conflictId === settlement.conflictId
    && decision.findingId === settlement.findingId
    && decision.outcome === settlement.outcome
    && event?.operation === 'normalize_provisional_conflicts'
    && event.transitions.some((transition) => (
      transition.after.entityKind === 'finding'
      && transition.after.entityId === settlement.findingId
    ));
}

export function validConflictLandingSettlements(
  ledger: FindingLedger,
  rawClaimLandingId: string,
): Array<AdjudicatedConflictClaimSettlement | ProvisionalConflictNormalizationSettlement> {
  return ledger.conflictClaimSettlements.filter((settlement) => (
    settlement.rawClaimLandingIds.includes(rawClaimLandingId)
    && ('attemptId' in settlement
      ? validStandardSettlement(ledger, settlement)
      : validNormalizationSettlement(ledger, settlement))
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
