import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  binarySortedUnique,
  computeConflictClaimSubjectId,
  computeConflictClaimUniverseDigest,
  computeConflictCoverageSnapshotDigest,
  computeConflictEpisodeId,
  computeConflictSnapshotId,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  AdjudicatedConflictClaimSettlement,
  ConflictAdjudicationEpisode,
  ConflictAdjudicationSnapshot,
  ConflictClaimSettlement,
  ConflictClaimSubject,
  ConflictTargetContentDigest,
} from '../../models/finding-contract-types.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingObservation,
} from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { hasVerifiedOrdinaryLifecycleCoverage } from '../../models/finding-lifecycle-continuity.js';

function existingTargetContentDigests(
  ledger: FindingLedger,
  conflictId: string,
): ConflictTargetContentDigest[] {
  const existing = [...ledger.conflictAdjudicationSnapshots]
    .reverse()
    .find((snapshot) => snapshot.conflictId === conflictId);
  return structuredClone(existing?.targetContentDigests ?? []);
}

function resolveTargetContentDigests(input: {
  ledger: FindingLedger;
  conflictId: string;
  targetContentDigests?: readonly ConflictTargetContentDigest[];
}): ConflictTargetContentDigest[] {
  if (input.targetContentDigests !== undefined) {
    return structuredClone([...input.targetContentDigests]);
  }
  // Lifecycle-only refreshes cannot recapture the working tree. Preserve the
  // last engine-captured target digest until a review-scope capture replaces it.
  return existingTargetContentDigests(input.ledger, input.conflictId);
}

function findingClaimSnapshotDigest(finding: FindingLedgerEntry): string {
  return findingContentAddress('conflict-finding-claim-snapshot', {
    findingId: finding.id,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    rawFindingIds: binarySortedUnique(finding.rawFindingIds),
    evidenceIds: binarySortedUnique(finding.evidenceIds),
  });
}

function evidenceBindingIdsForFinding(
  ledger: FindingLedger,
  findingId: string,
): string[] {
  return binarySortedUnique(ledger.evidenceBindings.flatMap((binding) => (
    binding.target.entityKind === 'finding' && binding.target.entityId === findingId
      ? [binding.bindingId]
      : []
  )));
}

function sourcePayloadDigests(
  ledger: FindingLedger,
  rawFindingIds: readonly string[],
): string[] {
  return binarySortedUnique(rawFindingIds.map((rawFindingId) => {
    const snapshots = ledger.rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === rawFindingId,
    );
    if (snapshots.length !== 1) {
      throw new Error(`Conflict subject raw finding "${rawFindingId}" has no exact canonical snapshot`);
    }
    return snapshots[0]!.rawPayloadDigest;
  }));
}

function subjectBase(input: {
  ledger: FindingLedger;
  conflictId: string;
  finding: FindingLedgerEntry;
  sourceRawFindingIds: string[];
}) {
  const expectedHead = captureFindingLifecycleHead(input.ledger, 'finding', input.finding.id);
  if (expectedHead === undefined) {
    throw new Error(`Conflict subject finding "${input.finding.id}" has no lifecycle head`);
  }
  const evidenceBindingIds = evidenceBindingIdsForFinding(input.ledger, input.finding.id);
  return {
    conflictId: input.conflictId,
    findingId: input.finding.id,
    expectedHead,
    targetIdentityHash: input.finding.targetIdentityHash,
    claimIdentityHash: input.finding.claimIdentityHash,
    semanticClaimIdentityHash: input.finding.semanticClaimIdentityHash,
    claimSnapshotDigest: findingClaimSnapshotDigest(input.finding),
    sourceRawFindingIds: binarySortedUnique(input.sourceRawFindingIds),
    sourceRawPayloadDigests: sourcePayloadDigests(input.ledger, input.sourceRawFindingIds),
    evidenceBindingIds,
    evidenceSetDigest: findingContentAddress('conflict-subject-evidence-set', {
      findingId: input.finding.id,
      evidenceBindingIds,
      evidenceIds: binarySortedUnique(input.finding.evidenceIds),
    }),
  };
}

function createProductSubject(input: {
  ledger: FindingLedger;
  conflictId: string;
  finding: FindingLedgerEntry;
}): ConflictClaimSubject {
  const withoutId = {
    ...subjectBase({
      ...input,
      sourceRawFindingIds: input.finding.rawFindingIds,
    }),
    role: 'product_finding' as const,
    rawClaimLandingIds: [] as [],
  };
  return { subjectId: computeConflictClaimSubjectId(withoutId), ...withoutId };
}

function createHoldingSubject(input: {
  ledger: FindingLedger;
  conflictId: string;
  finding: FindingLedgerEntry;
  rawClaimLandingIds: string[];
  sourceRawFindingIds: string[];
}): ConflictClaimSubject {
  const withoutId = {
    ...subjectBase(input),
    role: 'holding_provisional' as const,
    rawClaimLandingIds: binarySortedUnique(input.rawClaimLandingIds),
  };
  return { subjectId: computeConflictClaimSubjectId(withoutId), ...withoutId };
}

function validSettlementForSubject(
  ledger: FindingLedger,
  settlement: AdjudicatedConflictClaimSettlement,
): boolean {
  const snapshot = ledger.conflictAdjudicationSnapshots.find(
    (candidate) => candidate.conflictSnapshotId === settlement.conflictSnapshotId,
  );
  const subject = snapshot?.subjects.find((candidate) => candidate.subjectId === settlement.subjectId);
  const attempt = ledger.conflictAdjudicationAttempts.find(
    (candidate) => candidate.attemptId === settlement.attemptId,
  );
  return subject !== undefined
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

export function validConflictClaimSettlements(
  ledger: FindingLedger,
  conflictId: string,
): AdjudicatedConflictClaimSettlement[] {
  return ledger.conflictClaimSettlements.filter(
    (settlement): settlement is AdjudicatedConflictClaimSettlement => (
    'attemptId' in settlement
    && settlement.conflictId === conflictId
    && validSettlementForSubject(ledger, settlement)
    ),
  );
}

export function validConflictLandingSettlements(
  ledger: FindingLedger,
  conflictId: string,
): ConflictClaimSettlement[] {
  return ledger.conflictClaimSettlements.filter((settlement) => (
    settlement.conflictId === conflictId
    && validSettlementForSubject(ledger, settlement)
  ));
}

function unsettledProductFindingIds(
  ledger: FindingLedger,
  conflict: FindingLedgerConflict,
): string[] {
  const settled = new Set(validConflictClaimSettlements(ledger, conflict.id)
    .filter((settlement) => settlement.subjectRole === 'product_finding')
    .map((settlement) => settlement.findingId));
  return conflict.findingIds.filter((findingId) => !settled.has(findingId));
}

export function buildConflictAdjudicationSnapshot(input: {
  ledger: FindingLedger;
  conflictId: string;
  originStep: string | null;
  createdAt: FindingObservation;
  targetContentDigests?: readonly ConflictTargetContentDigest[];
}): ConflictAdjudicationSnapshot {
  const conflict = input.ledger.conflicts.find((candidate) => candidate.id === input.conflictId);
  if (conflict === undefined || conflict.status !== 'active') {
    throw new Error(`Cannot snapshot inactive conflict "${input.conflictId}"`);
  }
  const expectedConflictHead = captureFindingLifecycleHead(input.ledger, 'conflict', conflict.id);
  if (expectedConflictHead === undefined) {
    throw new Error(`Conflict "${conflict.id}" has no lifecycle head`);
  }
  const settlements = validConflictLandingSettlements(input.ledger, conflict.id);
  const settledLandingIds = new Set(settlements.flatMap((settlement) => settlement.rawClaimLandingIds));
  const unsettledLandings = input.ledger.conflictRawClaimLandings.filter((landing) => (
    landing.conflictId === conflict.id && !settledLandingIds.has(landing.rawClaimLandingId)
  ));
  const holdingGroups = new Map<string, typeof unsettledLandings>();
  for (const landing of unsettledLandings) {
    holdingGroups.set(
      landing.holdingFindingId,
      [...(holdingGroups.get(landing.holdingFindingId) ?? []), landing],
    );
  }
  const holdingSubjects = [...holdingGroups.entries()].map(([findingId, landings]) => {
    const finding = input.ledger.findings.find((candidate) => candidate.id === findingId);
    if (finding?.status !== 'open' || finding.provisional === undefined) {
      throw new Error(`Unsettled conflict holding "${findingId}" is not an open provisional`);
    }
    return createHoldingSubject({
      ledger: input.ledger,
      conflictId: conflict.id,
      finding,
      rawClaimLandingIds: landings.map((landing) => landing.rawClaimLandingId),
      sourceRawFindingIds: landings.map((landing) => landing.rawFindingId),
    });
  });
  const productSubjects = unsettledProductFindingIds(input.ledger, conflict).flatMap((findingId) => {
    const finding = input.ledger.findings.find((candidate) => candidate.id === findingId);
    if (finding === undefined) {
      throw new Error(`Conflict "${conflict.id}" references unknown product finding "${findingId}"`);
    }
    return finding.status === 'open' && finding.provisional === undefined
      ? [createProductSubject({ ledger: input.ledger, conflictId: conflict.id, finding })]
      : [];
  });
  const subjects = [...productSubjects, ...holdingSubjects]
    .sort((left, right) => compareBinaryStrings(left.subjectId, right.subjectId));
  const rawClaimLandingIds = binarySortedUnique(
    input.ledger.conflictRawClaimLandings
      .filter((landing) => landing.conflictId === conflict.id)
      .map((landing) => landing.rawClaimLandingId),
  );
  const claimUniverseDigest = computeConflictClaimUniverseDigest({
    conflictId: conflict.id,
    productFindingIds: conflict.findingIds,
    rawClaimLandingIds,
  });
  const priorSettlementIds = binarySortedUnique(settlements.map(({ settlementId }) => settlementId));
  const coverageSnapshotDigest = computeConflictCoverageSnapshotDigest({
    claimUniverseDigest,
    subjectIds: subjects.map(({ subjectId }) => subjectId),
    priorSettlementIds,
  });
  const evidenceSnapshotDigest = findingContentAddress('conflict-adjudication-evidence-snapshot', {
    conflictId: conflict.id,
    expectedConflictHead,
    subjects: subjects.map((subject) => ({
      subjectId: subject.subjectId,
      evidenceSetDigest: subject.evidenceSetDigest,
    })),
  });
  const targetContentDigests = resolveTargetContentDigests(input);
  const withoutId = {
    conflictId: conflict.id,
    expectedConflictHead,
    claimUniverseDigest,
    coverageSnapshotDigest,
    evidenceSnapshotDigest,
    rawClaimLandingIds,
    priorSettlementIds,
    subjects,
    targetContentDigests,
    originStep: input.originStep,
  };
  return {
    conflictSnapshotId: computeConflictSnapshotId(withoutId),
    ...withoutId,
    createdAt: structuredClone(input.createdAt),
  };
}

export function appendFreshConflictAdjudicationSnapshot(input: {
  ledger: FindingLedger;
  conflictId: string;
  originStep: string | null;
  createdAt: FindingObservation;
  targetContentDigests?: readonly ConflictTargetContentDigest[];
}): { ledger: FindingLedger; snapshot: ConflictAdjudicationSnapshot } {
  const current = input.ledger.conflictAdjudicationSnapshots.find((snapshot) => (
    snapshot.conflictId === input.conflictId
    && snapshotMatchesCurrentProjection(input.ledger, snapshot, input.targetContentDigests)
  ));
  if (current !== undefined) {
    return { ledger: input.ledger, snapshot: current };
  }
  const snapshot = buildConflictAdjudicationSnapshot(input);
  const existing = input.ledger.conflictAdjudicationSnapshots.find(
    (candidate) => candidate.conflictSnapshotId === snapshot.conflictSnapshotId,
  );
  if (existing !== undefined) {
    return { ledger: input.ledger, snapshot: existing };
  }
  return {
    ledger: {
      ...input.ledger,
      conflictAdjudicationSnapshots: [...input.ledger.conflictAdjudicationSnapshots, snapshot],
    },
    snapshot,
  };
}

function snapshotMatchesCurrentProjection(
  ledger: FindingLedger,
  snapshot: ConflictAdjudicationSnapshot,
  targetContentDigests?: readonly ConflictTargetContentDigest[],
): boolean {
  const rebuilt = buildConflictAdjudicationSnapshot({
    ledger,
    conflictId: snapshot.conflictId,
    originStep: snapshot.originStep,
    createdAt: snapshot.createdAt,
    targetContentDigests: targetContentDigests ?? snapshot.targetContentDigests ?? [],
  });
  return rebuilt.conflictSnapshotId === snapshot.conflictSnapshotId;
}

export function refreshActiveConflictAdjudicationSnapshots(input: {
  ledger: FindingLedger;
  originStep: string | null;
  createdAt: FindingObservation;
  targetContentDigestsByConflict?: ReadonlyMap<string, readonly ConflictTargetContentDigest[]>;
}): FindingLedger {
  let ledger = input.ledger;
  for (const conflict of ledger.conflicts) {
    if (conflict.status !== 'active') {
      continue;
    }
    ledger = appendFreshConflictAdjudicationSnapshot({
      ledger,
      conflictId: conflict.id,
      originStep: input.originStep,
      createdAt: input.createdAt,
      targetContentDigests: input.targetContentDigestsByConflict?.get(conflict.id),
    }).ledger;
  }
  return ledger;
}

export function freshConflictAdjudicationSnapshot(
  ledger: FindingLedger,
  conflictId: string,
): ConflictAdjudicationSnapshot {
  const head = captureFindingLifecycleHead(ledger, 'conflict', conflictId);
  if (head === undefined) {
    throw new Error(`Conflict "${conflictId}" has no current lifecycle head`);
  }
  const snapshots = ledger.conflictAdjudicationSnapshots.filter((snapshot) => (
    snapshot.conflictId === conflictId
    && canonicalJson(snapshot.expectedConflictHead) === canonicalJson(head)
    && snapshotMatchesCurrentProjection(ledger, snapshot, snapshot.targetContentDigests ?? [])
  ));
  const current = snapshots.at(-1);
  if (current === undefined) {
    throw new Error(`Active conflict "${conflictId}" must have a fresh adjudication snapshot`);
  }
  return current;
}

export function computeConflictAdjudicationRequestDigest(
  snapshot: ConflictAdjudicationSnapshot,
): string {
  return findingContentAddress('conflict-adjudication-request', {
    conflictSnapshotId: snapshot.conflictSnapshotId,
    coverageSnapshotDigest: snapshot.coverageSnapshotDigest,
    evidenceSnapshotDigest: snapshot.evidenceSnapshotDigest,
    subjects: snapshot.subjects,
    targetContentDigests: snapshot.targetContentDigests ?? [],
  });
}

export function createConflictAdjudicationEpisode(input: {
  snapshot: ConflictAdjudicationSnapshot;
  createdAt: FindingObservation;
}): ConflictAdjudicationEpisode {
  const withoutId = {
    conflictSnapshotId: input.snapshot.conflictSnapshotId,
    conflictId: input.snapshot.conflictId,
    expectedConflictHead: structuredClone(input.snapshot.expectedConflictHead),
    maxAttempts: 2 as const,
  };
  return {
    episodeId: computeConflictEpisodeId(withoutId),
    ...withoutId,
    createdAt: structuredClone(input.createdAt),
  };
}

export function isConflictSnapshotAdjudicated(
  ledger: FindingLedger,
  snapshot: ConflictAdjudicationSnapshot,
): boolean {
  return ledger.conflictAdjudicationAttempts.some((attempt) => (
    attempt.conflictSnapshotId === snapshot.conflictSnapshotId
    && canonicalJson(attempt.expectedConflictHead) === canonicalJson(snapshot.expectedConflictHead)
    && ledger.findingManagerProviderCalls.some((call) => (
      call.providerCallId === attempt.providerCallId
      && call.requestDigest === attempt.requestDigest
      && call.ownerAttemptId === attempt.attemptId
      && call.purpose === 'conflict_adjudication'
    ))
    && attempt.stage !== 'interrupted'
    && !(attempt.stage === 'completed' && attempt.result.kind === 'stale_precondition')
  ));
}

export function isActiveConflictUnadjudicated(
  ledger: FindingLedger,
  conflictId: string,
): boolean {
  const conflict = ledger.conflicts.find((candidate) => candidate.id === conflictId);
  if (conflict === undefined || conflict.status !== 'active') {
    return false;
  }
  // An unchanged conflict does not consume stop-budget rounds. The loop
  // monitor (or the workflow max_steps boundary) is the finite escape hatch
  // for repeated unresolved, code-unchanged rounds.
  return !isConflictSnapshotAdjudicated(
    ledger,
    freshConflictAdjudicationSnapshot(ledger, conflictId),
  );
}

function allProductClaimsDurablyCovered(
  ledger: FindingLedger,
  conflict: FindingLedgerConflict,
  settlements: readonly ConflictClaimSettlement[],
): boolean {
  const productSettlements = new Set(settlements
    .filter((settlement) => (
      'attemptId' in settlement
      && settlement.subjectRole === 'product_finding'
      && (settlement.outcome === 'resolved' || settlement.outcome === 'invalidated')
      && settlement.rawClaimLandingIds.length === 0
    ))
    .map((settlement) => settlement.findingId));
  return conflict.findingIds.every((findingId) => {
    if (productSettlements.has(findingId)) {
      return true;
    }
    const subjects = ledger.conflictAdjudicationSnapshots.flatMap((snapshot) => (
      snapshot.conflictId === conflict.id
        ? snapshot.subjects.filter((subject) => (
            subject.role === 'product_finding' && subject.findingId === findingId
          ))
        : []
    ));
    if (subjects.length === 0) {
      return false;
    }
    return subjects.some((subject) => hasVerifiedOrdinaryLifecycleCoverage({
      lifecycleEvents: ledger.lifecycleEvents,
      findingId,
      expectedHead: subject.expectedHead,
    }));
  });
}

export function hasSubstantiveVerifiedSettlementWitness(
  ledger: FindingLedger,
  conflictId: string,
): boolean {
  return validConflictLandingSettlements(ledger, conflictId).some((settlement) => (
    !('attemptId' in settlement)
    || settlement.subjectRole === 'holding_provisional'
    || (
      settlement.subjectRole === 'product_finding'
      && (settlement.outcome === 'resolved' || settlement.outcome === 'invalidated')
    )
  ));
}

export function isConflictResolved(
  ledger: FindingLedger,
  conflictId: string,
): boolean {
  const conflict = ledger.conflicts.find((candidate) => candidate.id === conflictId);
  if (conflict === undefined) {
    throw new Error(`Unknown conflict "${conflictId}"`);
  }
  if (
    new Set(conflict.findingIds).size !== conflict.findingIds.length
    || new Set(conflict.rawFindingIds).size !== conflict.rawFindingIds.length
    || conflict.findingIds.length + conflict.rawFindingIds.length === 0
  ) {
    return false;
  }
  const settlements = validConflictLandingSettlements(ledger, conflict.id);
  const landings = ledger.conflictRawClaimLandings.filter(
    (landing) => landing.conflictId === conflict.id,
  );
  const settledLandingIds = settlements
    .filter((settlement) => settlement.subjectRole === 'holding_provisional')
    .flatMap((settlement) => settlement.rawClaimLandingIds);
  const allRawClaimsSettledExactlyOnce = settledLandingIds.length === landings.length
    && new Set(settledLandingIds).size === settledLandingIds.length
    && landings.every((landing) => settledLandingIds.includes(landing.rawClaimLandingId));
  const noOpenConflictHoldingProvisional = landings.every((landing) => (
    settledLandingIds.includes(landing.rawClaimLandingId)
  ));
  const latestSnapshot = ledger.conflictAdjudicationSnapshots
    .filter((snapshot) => snapshot.conflictId === conflict.id)
    .sort((left, right) => right.expectedConflictHead.revision - left.expectedConflictHead.revision)[0];
  const settledSubjectIds = new Set(settlements
    .filter((settlement) => 'attemptId' in settlement)
    .map((settlement) => settlement.subjectId));
  const noUnsettledConflictHoldingSubject = latestSnapshot !== undefined
    && latestSnapshot.subjects.every((subject) => (
      subject.role !== 'holding_provisional'
      || settledSubjectIds.has(subject.subjectId)
      || subject.rawClaimLandingIds.every((landingId) => settledLandingIds.includes(landingId))
    ));
  const noLiveConflictAttempt = !ledger.conflictAdjudicationAttempts.some((attempt) => (
    attempt.conflictId === conflict.id
    && (attempt.stage === 'started' || attempt.stage === 'proposed')
  ));
  return hasSubstantiveVerifiedSettlementWitness(ledger, conflict.id)
    && allRawClaimsSettledExactlyOnce
    && allProductClaimsDurablyCovered(ledger, conflict, settlements)
    && noOpenConflictHoldingProvisional
    && noUnsettledConflictHoldingSubject
    && noLiveConflictAttempt;
}
