import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  computeConflictClaimUniverseDigest,
  computeConflictRawClaimSnapshotDigest,
  computeIndependentProvisionalClaimKey,
  computeIndependentProvisionalLineageKey,
  computeIndependentProvisionalStableKey,
  computeLegacyProvisionalConflictBatchFingerprintDigest,
  computeProvisionalConflictAssociationId,
  computeProvisionalConflictDecisionDigest,
  computeProvisionalConflictFinalIntentDigest,
  computeProvisionalConflictNormalizationId,
  computeProvisionalConflictNormalizationSettlementId,
  computeProvisionalConflictNormalizationSnapshotId,
  computeProvisionalConflictNormalizationSubjectId,
  computeProvisionalConflictProofUniverseDigest,
  computeProvisionalConflictReleaseWitnessId,
  computeProvisionalConflictSourceProjectionDigest,
  computeRawProvisionalExactClaimIdentityDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { computeFindingLifecycleProjectionDigest } from '../../models/finding-lifecycle-identity.js';
import { assertFindingLifecycleAuthorityInvariant } from '../../models/finding-lifecycle-invariants.js';
import type {
  ConflictRawClaimLanding,
  LegacyHoldingConflictOwner,
  LegacyProvisionalConflictBatchFingerprint,
  ProvisionalConflictAssociationCandidate,
  ProvisionalConflictNormalizationDecision,
  ProvisionalConflictNormalizationFinalFindingIntent,
  ProvisionalConflictNormalizationRecord,
  ProvisionalConflictNormalizationSettlement,
  ProvisionalConflictNormalizationSnapshot,
  ProvisionalConflictNormalizationSubject,
  ProvisionalConflictReleaseWitness,
  VerifiedLegacyProvisionalIdentity,
} from '../../models/finding-contract-types.js';
import type {
  EngineProofRecord,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingObservation,
  ProvisionalFindingEntry,
} from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { applyFindingLifecycleCommands, type FindingLifecycleCommand } from './lifecycle-transaction.js';
import type { ParsedLegacyFindingLedger, SourceAuthorityRaw } from '../../../infra/finding-storage/inherited-source-parser.js';

interface NormalizationSubjectState {
  subject: ProvisionalConflictNormalizationSubject;
  finding: ProvisionalFindingEntry;
  identity: VerifiedLegacyProvisionalIdentity;
}

function hasPermittedLandingHeadEvolution(input: {
  ledger: FindingLedger;
  landing: ConflictRawClaimLanding;
  currentHead: ConflictRawClaimLanding['holdingHeadAfterLanding'];
}): boolean {
  let head = input.landing.holdingHeadAfterLanding;
  if (canonicalJson(head) !== canonicalJson(input.currentHead)) {
    assertFindingLifecycleAuthorityInvariant(input.ledger);
  }
  let foundLandingEvent = false;
  for (const event of input.ledger.lifecycleEvents) {
    const transition = event.transitions.find((candidate) => (
      candidate.after.entityKind === 'finding'
      && candidate.after.entityId === input.landing.holdingFindingId
    ));
    if (event.eventId === input.landing.landingEventId) {
      if (
        event.operation !== 'update_provisional'
        || transition === undefined
        || canonicalJson(transition.after) !== canonicalJson(head)
      ) {
        return false;
      }
      foundLandingEvent = true;
      continue;
    }
    if (!foundLandingEvent || transition === undefined) {
      continue;
    }
    if (
      event.operation !== 'record_rejected_observation'
      || canonicalJson(transition.before) !== canonicalJson(head)
    ) {
      return false;
    }
    head = transition.after;
  }
  return foundLandingEvent
    && canonicalJson(head) === canonicalJson(input.currentHead);
}

function exactOne<Value>(values: readonly Value[], label: string): Value {
  if (values.length !== 1) {
    throw new Error(`Legacy provisional conflict requires exactly one ${label}; found ${values.length}`);
  }
  return values[0]!;
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`Legacy provisional conflict ${label} must be non-empty and unique`);
  }
}

function currentHead(
  ledger: FindingLedger,
  entityKind: 'finding' | 'conflict',
  entityId: string,
) {
  const head = captureFindingLifecycleHead(ledger, entityKind, entityId);
  if (head === undefined) {
    throw new Error(`Legacy provisional conflict ${entityKind} "${entityId}" has no lifecycle head`);
  }
  return head;
}

function claimEvidenceSetDigest(ledger: FindingLedger, finding: FindingLedgerEntry): {
  evidenceBindingIds: string[];
  evidenceSetDigest: string;
} {
  const evidenceBindingIds = binarySortedUnique(ledger.evidenceBindings.flatMap((binding) => (
    binding.target.entityKind === 'finding' && binding.target.entityId === finding.id
      ? [binding.bindingId]
      : []
  )));
  return {
    evidenceBindingIds,
    evidenceSetDigest: findingContentAddress('conflict-subject-evidence-set', {
      findingId: finding.id,
      evidenceBindingIds,
      evidenceIds: binarySortedUnique(finding.evidenceIds),
    }),
  };
}

function verifyIdentity(input: {
  ledger: FindingLedger;
  finding: ProvisionalFindingEntry;
  role: VerifiedLegacyProvisionalIdentity['role'];
  sourceRawFindingIds: string[];
}): VerifiedLegacyProvisionalIdentity {
  const { finding } = input;
  if (
    finding.targetIdentityHash === null
    || finding.claimIdentityHash === null
    || finding.semanticClaimIdentityHash === null
    || input.sourceRawFindingIds.length === 0
  ) {
    throw new Error(`Legacy provisional subject "${finding.id}" has incomplete identity`);
  }
  const snapshots = input.sourceRawFindingIds.map((rawFindingId) => {
    exactOne(
      input.ledger.rawFindings.filter((raw) => raw.rawFindingId === rawFindingId),
      `raw finding "${rawFindingId}"`,
    );
    return exactOne(
      input.ledger.rawCanonicalSnapshots.filter((snapshot) => snapshot.rawFindingId === rawFindingId),
      `raw canonical snapshot "${rawFindingId}"`,
    );
  });
  for (const snapshot of snapshots) {
    if (
      snapshot.targetIdentityHash !== finding.targetIdentityHash
      || snapshot.claimIdentityHash !== finding.claimIdentityHash
      || snapshot.semanticClaimIdentityHash !== finding.semanticClaimIdentityHash
    ) {
      throw new Error(`Legacy provisional subject "${finding.id}" has inconsistent raw identity`);
    }
  }
  const claimSnapshotDigests = new Set(
    snapshots.map((snapshot) => computeConflictRawClaimSnapshotDigest(snapshot)),
  );
  if (claimSnapshotDigests.size !== 1) {
    throw new Error(`Legacy provisional subject "${finding.id}" has mixed claim snapshots`);
  }
  return {
    findingId: finding.id,
    role: input.role,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    claimSnapshotDigest: [...claimSnapshotDigests][0]!,
    rawFindingIds: binarySortedUnique(input.sourceRawFindingIds),
    rawCanonicalSnapshotIds: binarySortedUnique(
      snapshots.map((snapshot) => snapshot.rawCanonicalSnapshotId),
    ),
  };
}

function makeSubject(input: {
  ledger: FindingLedger;
  conflictId: string;
  finding: ProvisionalFindingEntry;
  role: VerifiedLegacyProvisionalIdentity['role'];
  sourceRawFindingIds: string[];
  rawClaimLandingIds: string[];
}): NormalizationSubjectState {
  const identity = verifyIdentity(input);
  const evidence = claimEvidenceSetDigest(input.ledger, input.finding);
  const base = {
    conflictId: input.conflictId,
    findingId: input.finding.id,
    expectedHead: currentHead(input.ledger, 'finding', input.finding.id),
    targetIdentityHash: identity.targetIdentityHash,
    claimIdentityHash: identity.claimIdentityHash,
    semanticClaimIdentityHash: identity.semanticClaimIdentityHash,
    claimSnapshotDigest: identity.claimSnapshotDigest,
    sourceRawFindingIds: identity.rawFindingIds,
    sourceRawPayloadDigests: identity.rawCanonicalSnapshotIds.map((snapshotId) => (
      exactOne(
        input.ledger.rawCanonicalSnapshots.filter(
          (snapshot) => snapshot.rawCanonicalSnapshotId === snapshotId,
        ),
        `raw canonical snapshot id "${snapshotId}"`,
      ).rawPayloadDigest
    )).sort(compareBinaryStrings),
    ...evidence,
  };
  const withoutId = input.role === 'provisional_target'
    ? { ...base, role: 'provisional_target' as const, rawClaimLandingIds: [] as [] }
    : {
        ...base,
        role: 'holding_provisional' as const,
        rawClaimLandingIds: binarySortedUnique(input.rawClaimLandingIds),
        independentClaimKey: computeIndependentProvisionalClaimKey(identity),
        independentLineageKey: computeIndependentProvisionalLineageKey(
          computeIndependentProvisionalClaimKey(identity),
        ),
        independentStableKey: computeIndependentProvisionalStableKey(
          computeIndependentProvisionalClaimKey(identity),
        ),
      };
  return {
    subject: {
      subjectId: computeProvisionalConflictNormalizationSubjectId(withoutId),
      ...withoutId,
    },
    finding: input.finding,
    identity,
  };
}

function canonicalLegacyProjection(ledger: ParsedLegacyFindingLedger): object {
  const projection = JSON.parse(JSON.stringify(ledger)) as Record<string, unknown>;
  delete projection.updatedAt;
  delete projection.pendingManagerCommit;
  for (const [key, value] of Object.entries(projection)) {
    if (Array.isArray(value)) {
      projection[key] = [...value].sort((left, right) => (
        compareBinaryStrings(canonicalJson(left), canonicalJson(right))
      ));
    }
  }
  return projection;
}

function asCurrentLedger(legacy: ParsedLegacyFindingLedger): FindingLedger {
  return {
    ...structuredClone(legacy),
    provisionalConflictNormalizationSnapshots: [],
    provisionalConflictNormalizations: [],
  };
}

function assertLegacyAttemptRegistry(ledger: FindingLedger, conflictIds: ReadonlySet<string>): void {
  for (const attempt of ledger.conflictAdjudicationAttempts) {
    if (!conflictIds.has(attempt.conflictId)) {
      throw new Error(`Legacy conflict attempt "${attempt.attemptId}" is outside the normalization batch`);
    }
    if (attempt.stage === 'started' || attempt.stage === 'proposed' || attempt.stage === 'applied') {
      throw new Error(`Legacy conflict attempt "${attempt.attemptId}" is not quiescent`);
    }
  }
  for (const episode of ledger.conflictAdjudicationEpisodes) {
    if (!conflictIds.has(episode.conflictId)) {
      throw new Error(`Legacy conflict episode "${episode.episodeId}" is outside the normalization batch`);
    }
  }
  for (const snapshot of ledger.conflictAdjudicationSnapshots) {
    if (!conflictIds.has(snapshot.conflictId)) {
      throw new Error(`Legacy conflict snapshot "${snapshot.conflictSnapshotId}" is outside the normalization batch`);
    }
  }
}

function collectLegacyBatch(input: {
  ledger: FindingLedger;
  sourceProjectionDigest: string;
  capturedAt: FindingObservation;
}): {
  conflicts: FindingLedgerConflict[];
  states: NormalizationSubjectState[];
  conflictRefs: ProvisionalConflictNormalizationSnapshot['conflicts'];
  holdingOwners: LegacyHoldingConflictOwner[];
} {
  const conflicts = input.ledger.conflicts.filter((conflict) => conflict.status === 'active');
  if (conflicts.length === 0) {
    throw new Error('Legacy provisional conflict normalization requires at least one active conflict');
  }
  const conflictIds = new Set(conflicts.map((conflict) => conflict.id));
  assertLegacyAttemptRegistry(input.ledger, conflictIds);
  if (input.ledger.conflictClaimSettlements.length !== 0) {
    throw new Error('Legacy provisional conflict batch cannot contain claim settlements');
  }
  const states: NormalizationSubjectState[] = [];
  const conflictRefs: ProvisionalConflictNormalizationSnapshot['conflicts'] = [];
  const holdingOwners: LegacyHoldingConflictOwner[] = [];
  const targetIds = new Set<string>();
  const holdingIds = new Set<string>();
  for (const conflict of conflicts) {
    assertUnique(conflict.findingIds, `findingIds for conflict "${conflict.id}"`);
    assertUnique(conflict.rawFindingIds, `rawFindingIds for conflict "${conflict.id}"`);
    const expectedConflictHead = currentHead(input.ledger, 'conflict', conflict.id);
    const targetStates = conflict.findingIds.map((findingId) => {
      const finding = exactOne(
        input.ledger.findings.filter((candidate) => candidate.id === findingId),
        `target finding "${findingId}"`,
      );
      if (finding.status !== 'open' || finding.provisional === undefined) {
        throw new Error(`Legacy conflict target "${findingId}" is not an open provisional`);
      }
      const provisionalFinding = finding as ProvisionalFindingEntry;
      targetIds.add(findingId);
      return makeSubject({
        ledger: input.ledger,
        conflictId: conflict.id,
        finding: provisionalFinding,
        role: 'provisional_target',
        sourceRawFindingIds: provisionalFinding.provisional.sourceRawFindingIds,
        rawClaimLandingIds: [],
      });
    });
    const landings = conflict.rawFindingIds.map((rawFindingId) => exactOne(
      input.ledger.conflictRawClaimLandings.filter((landing) => (
        landing.conflictId === conflict.id && landing.rawFindingId === rawFindingId
      )),
      `landing for conflict "${conflict.id}" raw "${rawFindingId}"`,
    ));
    const allConflictLandings = input.ledger.conflictRawClaimLandings.filter(
      (landing) => landing.conflictId === conflict.id,
    );
    if (allConflictLandings.length !== landings.length) {
      throw new Error(`Legacy conflict "${conflict.id}" has excess raw claim landings`);
    }
    const holdingStates = [...new Set(landings.map((landing) => landing.holdingFindingId))]
      .map((findingId) => {
        const owned = landings.filter((landing) => landing.holdingFindingId === findingId);
        const finding = exactOne(
          input.ledger.findings.filter((candidate) => candidate.id === findingId),
          `holding finding "${findingId}"`,
        );
        if (finding.status !== 'open' || finding.provisional === undefined) {
          throw new Error(`Legacy conflict holding "${findingId}" is not an open provisional`);
        }
        const provisionalFinding = finding as ProvisionalFindingEntry;
        holdingIds.add(findingId);
        holdingOwners.push({
          holdingFindingId: findingId,
          conflictId: conflict.id,
          rawClaimLandingIds: binarySortedUnique(owned.map((landing) => landing.rawClaimLandingId)),
        });
        for (const landing of owned) {
          const snapshot = exactOne(
            input.ledger.rawCanonicalSnapshots.filter(
              (candidate) => candidate.rawCanonicalSnapshotId === landing.rawCanonicalSnapshotId,
            ),
            `landing snapshot "${landing.rawCanonicalSnapshotId}"`,
          );
          if (
            snapshot.rawFindingId !== landing.rawFindingId
            || snapshot.rawPayloadDigest !== landing.rawPayloadDigest
            || computeConflictRawClaimSnapshotDigest(snapshot) !== landing.claimSnapshotDigest
            || !hasPermittedLandingHeadEvolution({
              ledger: input.ledger,
              landing,
              currentHead: currentHead(input.ledger, 'finding', findingId),
            })
          ) {
            throw new Error(`Legacy conflict landing "${landing.rawClaimLandingId}" is inconsistent`);
          }
        }
        return makeSubject({
          ledger: input.ledger,
          conflictId: conflict.id,
          finding: provisionalFinding,
          role: 'holding_provisional',
          sourceRawFindingIds: owned.map((landing) => landing.rawFindingId),
          rawClaimLandingIds: owned.map((landing) => landing.rawClaimLandingId),
        });
      });
    const legacySnapshot = exactOne(
      input.ledger.conflictAdjudicationSnapshots.filter((snapshot) => (
        snapshot.conflictId === conflict.id
        && canonicalJson(snapshot.expectedConflictHead) === canonicalJson(expectedConflictHead)
        && snapshot.subjects.length === holdingStates.length
        && snapshot.subjects.every((subject) => {
          const state = holdingStates.find(
            (candidate) => candidate.finding.id === subject.findingId,
          );
          return subject.role === 'holding_provisional'
            && state !== undefined
            && canonicalJson(subject.expectedHead)
              === canonicalJson(state.subject.expectedHead);
        })
      )),
      `fresh legacy snapshot for conflict "${conflict.id}"`,
    );
    if (
      legacySnapshot.subjects.some((subject) => subject.role !== 'holding_provisional')
      || canonicalJson(binarySortedUnique(legacySnapshot.rawClaimLandingIds))
        !== canonicalJson(binarySortedUnique(landings.map((landing) => landing.rawClaimLandingId)))
      || canonicalJson(binarySortedUnique(legacySnapshot.subjects.flatMap(
        (subject) => subject.rawClaimLandingIds,
      ))) !== canonicalJson(binarySortedUnique(landings.map((landing) => landing.rawClaimLandingId)))
    ) {
      throw new Error(`Legacy conflict "${conflict.id}" does not match the frozen snapshot shape`);
    }
    states.push(...targetStates, ...holdingStates);
    conflictRefs.push({
      conflictId: conflict.id,
      expectedConflictHead,
      legacyConflictSnapshotId: legacySnapshot.conflictSnapshotId,
      findingIds: binarySortedUnique(conflict.findingIds),
      rawFindingIds: binarySortedUnique(conflict.rawFindingIds),
      rawClaimLandingIds: binarySortedUnique(landings.map((landing) => landing.rawClaimLandingId)),
      provisionalTargetSubjectIds: binarySortedUnique(targetStates.map(({ subject }) => subject.subjectId)),
      holdingSubjectIds: binarySortedUnique(holdingStates.map(({ subject }) => subject.subjectId)),
      claimUniverseDigest: computeConflictClaimUniverseDigest({
        conflictId: conflict.id,
        productFindingIds: conflict.findingIds,
        rawClaimLandingIds: landings.map((landing) => landing.rawClaimLandingId),
      }),
    });
  }
  if ([...targetIds].some((findingId) => holdingIds.has(findingId))) {
    throw new Error('Legacy provisional target and holding finding sets overlap');
  }
  if (
    targetIds.size !== states.filter(({ subject }) => subject.role === 'provisional_target').length
    || holdingIds.size !== states.filter(({ subject }) => subject.role === 'holding_provisional').length
  ) {
    throw new Error('Legacy provisional subjects must have exact-one batch ownership');
  }
  const ownerCounts = new Map<string, Set<string>>();
  for (const owner of holdingOwners) {
    ownerCounts.set(
      owner.holdingFindingId,
      new Set([...(ownerCounts.get(owner.holdingFindingId) ?? []), owner.conflictId]),
    );
  }
  if (
    holdingOwners.length !== ownerCounts.size
    || [...ownerCounts.values()].some((owners) => owners.size !== 1)
  ) {
    throw new Error('Legacy holding finding must have exactly one conflict owner');
  }
  return { conflicts, states, conflictRefs, holdingOwners };
}

function mergeFindingClaims(
  target: ProvisionalFindingEntry,
  sources: readonly ProvisionalFindingEntry[],
  observedAt: FindingObservation,
): ProvisionalFindingEntry {
  return {
    ...target,
    lifecycle: 'persists',
    revision: target.revision + 1,
    rawFindingIds: binarySortedUnique([...new Set(
      [target.rawFindingIds, ...sources.map((source) => source.rawFindingIds)].flat(),
    )]),
    reviewers: binarySortedUnique([...new Set(
      [target.reviewers, ...sources.map((source) => source.reviewers)].flat(),
    )]),
    evidenceIds: binarySortedUnique([...new Set(
      [target.evidenceIds, ...sources.map((source) => source.evidenceIds)].flat(),
    )]),
    lastSeen: structuredClone(observedAt),
    provisional: {
      ...target.provisional,
      sourceRawFindingIds: binarySortedUnique([...new Set([
        target.provisional.sourceRawFindingIds,
        ...sources.map((source) => source.provisional.sourceRawFindingIds),
      ].flat())]),
      lastObservedAt: structuredClone(observedAt),
    },
  };
}

function supersedeFinding(
  finding: ProvisionalFindingEntry,
  targetFindingId: string,
  observedAt: FindingObservation,
): FindingLedgerEntry {
  const { provisional: _provisional, ...withoutProvisional } = finding;
  void _provisional;
  return {
    ...withoutProvisional,
    status: 'superseded',
    lifecycle: 'superseded',
    revision: finding.revision + 1,
    lastSeen: structuredClone(observedAt),
    supersededByFindingId: targetFindingId,
  };
}

function intentFor(input: {
  after: FindingLedgerEntry;
  expectedHead: ReturnType<typeof currentHead>;
  sourceSubjectIds: string[];
  absorbedFindingIds: string[];
}): ProvisionalConflictNormalizationFinalFindingIntent {
  const after = input.after;
  if (after.status === 'superseded') {
    const withoutDigest = {
      kind: 'superseded' as const,
      findingId: after.id,
      expectedHead: input.expectedHead,
      sourceSubjectIds: binarySortedUnique(input.sourceSubjectIds),
      afterRevision: after.revision,
      afterLifecycle: 'superseded' as const,
      supersededByFindingId: after.supersededByFindingId!,
      provisionalAfter: null as null,
    };
    return { ...withoutDigest, intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest) };
  }
  if (after.provisional === undefined) {
    throw new Error(`Normalization finding "${after.id}" lost provisional metadata`);
  }
  const withoutDigest = {
    kind: 'open_provisional' as const,
    findingId: after.id,
    expectedHead: input.expectedHead,
    sourceSubjectIds: binarySortedUnique(input.sourceSubjectIds),
    afterRevision: after.revision,
    afterLifecycle: 'persists' as const,
    stableKey: after.provisional.stableKey,
    lineageKey: after.provisional.lineageKey,
    rawFindingIds: binarySortedUnique(after.rawFindingIds),
    provisionalSourceRawFindingIds: binarySortedUnique(after.provisional.sourceRawFindingIds),
    reviewerIds: binarySortedUnique(after.reviewers),
    evidenceIds: binarySortedUnique(after.evidenceIds),
    absorbedFindingIds: binarySortedUnique(input.absorbedFindingIds),
  };
  return { ...withoutDigest, intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest) };
}

function resolveFinalAssociationTarget(input: {
  sourceSubjectId: string;
  chosenAssociationByHolding: ReadonlyMap<string, ProvisionalConflictAssociationCandidate>;
  stateBySubjectId: ReadonlyMap<string, NormalizationSubjectState>;
  resolvedBySubjectId: Map<string, NormalizationSubjectState>;
  visiting: Set<string>;
}): NormalizationSubjectState {
  const resolved = input.resolvedBySubjectId.get(input.sourceSubjectId);
  if (resolved !== undefined) {
    return resolved;
  }
  if (input.visiting.has(input.sourceSubjectId)) {
    throw new Error('Legacy provisional conflict association graph contains a cycle');
  }
  const state = input.stateBySubjectId.get(input.sourceSubjectId);
  if (state === undefined) {
    throw new Error(`Legacy provisional conflict association references unknown subject "${input.sourceSubjectId}"`);
  }
  const association = input.chosenAssociationByHolding.get(input.sourceSubjectId);
  if (association === undefined) {
    input.resolvedBySubjectId.set(input.sourceSubjectId, state);
    return state;
  }
  input.visiting.add(input.sourceSubjectId);
  const target = resolveFinalAssociationTarget({
    ...input,
    sourceSubjectId: association.targetSubjectId,
  });
  input.visiting.delete(input.sourceSubjectId);
  input.resolvedBySubjectId.set(input.sourceSubjectId, target);
  return target;
}

function setFinalIntent(
  intents: Map<string, ProvisionalConflictNormalizationFinalFindingIntent>,
  intent: ProvisionalConflictNormalizationFinalFindingIntent,
): void {
  const existing = intents.get(intent.findingId);
  if (existing !== undefined) {
    if (existing.kind !== intent.kind) {
      throw new Error(
        `Legacy provisional finding "${intent.findingId}" requires both open and superseded final intents`,
      );
    }
    if (existing.intentDigest !== intent.intentDigest) {
      throw new Error(`Legacy provisional finding "${intent.findingId}" has conflicting final intents`);
    }
    return;
  }
  intents.set(intent.findingId, intent);
}

function withoutRevision(finding: FindingLedgerEntry): FindingLifecycleCommand['changes']['findings'][number] {
  const { revision: _revision, ...projection } = finding;
  void _revision;
  return projection;
}

export interface NormalizeInheritedProvisionalTargetConflictsInput {
  source: SourceAuthorityRaw;
  legacyLedger: ParsedLegacyFindingLedger;
  destinationRunId: string;
  recordedAt: FindingObservation;
}

export interface NormalizeInheritedProvisionalTargetConflictsResult {
  ledger: FindingLedger;
  snapshot: ProvisionalConflictNormalizationSnapshot;
  record: ProvisionalConflictNormalizationRecord;
  settlements: ProvisionalConflictNormalizationSettlement[];
  fingerprint: LegacyProvisionalConflictBatchFingerprint;
}

export function normalizeInheritedProvisionalTargetConflicts(
  input: NormalizeInheritedProvisionalTargetConflictsInput,
): NormalizeInheritedProvisionalTargetConflictsResult {
  let ledger = asCurrentLedger(input.legacyLedger);
  const sourceProjectionDigest = computeProvisionalConflictSourceProjectionDigest({
    authorityKey: input.source.authorityKey,
    sourceWorkflowName: input.source.workflowName,
    sourceRevision: input.source.revision,
    ledger: canonicalLegacyProjection(input.legacyLedger),
  });
  const batch = collectLegacyBatch({
    ledger,
    sourceProjectionDigest,
    capturedAt: input.recordedAt,
  });
  const targets = batch.states.filter(({ subject }) => subject.role === 'provisional_target');
  const holdings = batch.states.filter(({ subject }) => subject.role === 'holding_provisional');
  const candidates: ProvisionalConflictAssociationCandidate[] = [];
  for (const holding of holdings) {
    for (const target of targets.filter(
      ({ subject }) => subject.conflictId === holding.subject.conflictId,
    )) {
      const withoutId = {
        sourceHoldingSubjectId: holding.subject.subjectId,
        targetSubjectId: target.subject.subjectId,
        targetSubjectRole: 'provisional_target' as const,
        basis: 'conflict_target' as const,
      };
      candidates.push({ associationId: computeProvisionalConflictAssociationId(withoutId), ...withoutId });
    }
  }
  const holdingsByKey = new Map<string, NormalizationSubjectState[]>();
  for (const holding of holdings) {
    const key = holding.subject.role === 'holding_provisional'
      ? holding.subject.independentStableKey
      : '';
    holdingsByKey.set(key, [...(holdingsByKey.get(key) ?? []), holding]);
  }
  for (const grouped of holdingsByKey.values()) {
    const canonical = [...grouped].sort((left, right) => (
      compareBinaryStrings(left.finding.id, right.finding.id)
    ))[0];
    if (canonical === undefined) continue;
    for (const holding of grouped) {
      if (holding === canonical) continue;
      const withoutId = {
        sourceHoldingSubjectId: holding.subject.subjectId,
        targetSubjectId: canonical.subject.subjectId,
        targetSubjectRole: 'holding_provisional' as const,
        basis: 'independent_key_collision' as const,
      };
      candidates.push({ associationId: computeProvisionalConflictAssociationId(withoutId), ...withoutId });
    }
  }
  const stateBySubjectId = new Map(batch.states.map((state) => [state.subject.subjectId, state]));
  const provenCandidates = candidates.filter((candidate) => {
    const source = stateBySubjectId.get(candidate.sourceHoldingSubjectId)!;
    const target = stateBySubjectId.get(candidate.targetSubjectId)!;
    return source.identity.targetIdentityHash === target.identity.targetIdentityHash
      && source.identity.claimIdentityHash === target.identity.claimIdentityHash
      && source.identity.semanticClaimIdentityHash === target.identity.semanticClaimIdentityHash;
  });
  const associationProofs = provenCandidates.map((candidate): EngineProofRecord => {
    const source = stateBySubjectId.get(candidate.sourceHoldingSubjectId)!;
    const target = stateBySubjectId.get(candidate.targetSubjectId)!;
    const exactClaimIdentityDigest = computeRawProvisionalExactClaimIdentityDigest(source.identity);
    return createEngineProofRecord({
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: ledger.workflowName,
      runId: input.destinationRunId,
      scopeIdentity: sourceProjectionDigest,
      snapshotId: sourceProjectionDigest,
      targetFindingId: target.finding.id,
      claimIdentityHash: source.identity.claimIdentityHash,
      dependencyDigests: binarySortedUnique([...new Set([
        source.subject.expectedHead.projectionDigest,
        target.subject.expectedHead.projectionDigest,
        source.subject.claimSnapshotDigest,
        target.subject.claimSnapshotDigest,
      ])]),
      resultDigest: exactClaimIdentityDigest,
      subject: {
        kind: 'provisional_conflict_association_identical',
        associationId: candidate.associationId,
        sourceHoldingSubjectId: candidate.sourceHoldingSubjectId,
        targetSubjectId: candidate.targetSubjectId,
        targetSubjectRole: candidate.targetSubjectRole,
        sourceExpectedHead: source.subject.expectedHead,
        targetExpectedHead: target.subject.expectedHead,
        sourceClaimSnapshotDigest: source.subject.claimSnapshotDigest,
        targetClaimSnapshotDigest: target.subject.claimSnapshotDigest,
        exactClaimIdentityDigest,
      },
      issuedAt: input.recordedAt.timestamp,
    });
  });
  const proofByAssociationId = new Map(associationProofs.map((proof) => [
    proof.subject.kind === 'provisional_conflict_association_identical'
      ? proof.subject.associationId
      : '',
    proof,
  ]));
  const proofUniverseWithoutDigest = {
    trustedVerifierId: 'takt.finding-lifecycle-policy' as const,
    trustedVerifierVersion: '1' as const,
    candidateAssociations: [...candidates].sort((a, b) => compareBinaryStrings(a.associationId, b.associationId)),
    mechanicalExactAssociationIds: binarySortedUnique(provenCandidates.map(({ associationId }) => associationId)),
    trustedProofRecordIds: binarySortedUnique(associationProofs.map(({ proofId }) => proofId)),
    provenAssociationIds: binarySortedUnique(provenCandidates.map(({ associationId }) => associationId)),
  };
  const proofUniverse = {
    ...proofUniverseWithoutDigest,
    proofUniverseDigest: computeProvisionalConflictProofUniverseDigest(proofUniverseWithoutDigest),
  };
  const snapshotWithoutId = {
    sourceProjectionDigest,
    workflowName: ledger.workflowName,
    conflicts: [...batch.conflictRefs].sort((a, b) => compareBinaryStrings(a.conflictId, b.conflictId)),
    subjects: batch.states.map(({ subject }) => subject)
      .sort((a, b) => compareBinaryStrings(a.subjectId, b.subjectId)),
    proofUniverse,
  };
  const snapshot: ProvisionalConflictNormalizationSnapshot = {
    normalizationSnapshotId: computeProvisionalConflictNormalizationSnapshotId(snapshotWithoutId),
    ...snapshotWithoutId,
    capturedAt: input.recordedAt,
  };
  const chosenAssociationByHolding = new Map<string, ProvisionalConflictAssociationCandidate>();
  for (const candidate of [...provenCandidates].sort((a, b) => (
    Number(a.basis !== 'conflict_target') - Number(b.basis !== 'conflict_target')
    || compareBinaryStrings(a.targetSubjectId, b.targetSubjectId)
  ))) {
    if (!chosenAssociationByHolding.has(candidate.sourceHoldingSubjectId)) {
      chosenAssociationByHolding.set(candidate.sourceHoldingSubjectId, candidate);
    }
  }
  const finalTargetBySubjectId = new Map<string, NormalizationSubjectState>();
  for (const state of batch.states) {
    resolveFinalAssociationTarget({
      sourceSubjectId: state.subject.subjectId,
      chosenAssociationByHolding,
      stateBySubjectId,
      resolvedBySubjectId: finalTargetBySubjectId,
      visiting: new Set(),
    });
  }
  const absorbedByFinalTarget = new Map<string, NormalizationSubjectState[]>();
  for (const holdingSubjectId of chosenAssociationByHolding.keys()) {
    const finalTarget = finalTargetBySubjectId.get(holdingSubjectId)!;
    absorbedByFinalTarget.set(
      finalTarget.subject.subjectId,
      [
        ...(absorbedByFinalTarget.get(finalTarget.subject.subjectId) ?? []),
        stateBySubjectId.get(holdingSubjectId)!,
      ],
    );
  }
  const afterByFindingId = new Map<string, FindingLedgerEntry>();
  const intentByFindingId = new Map<string, ProvisionalConflictNormalizationFinalFindingIntent>();
  for (const state of batch.states) {
    const chosen = chosenAssociationByHolding.get(state.subject.subjectId);
    if (chosen !== undefined) {
      const finalTarget = finalTargetBySubjectId.get(state.subject.subjectId)!;
      const after = supersedeFinding(state.finding, finalTarget.finding.id, input.recordedAt);
      afterByFindingId.set(state.finding.id, after);
      setFinalIntent(intentByFindingId, intentFor({
        after,
        expectedHead: state.subject.expectedHead,
        sourceSubjectIds: [state.subject.subjectId],
        absorbedFindingIds: [],
      }));
      continue;
    }
    const absorbed = absorbedByFinalTarget.get(state.subject.subjectId) ?? [];
    let after = mergeFindingClaims(state.finding, absorbed.map(({ finding }) => finding), input.recordedAt);
    if (state.subject.role === 'holding_provisional') {
      after = {
        ...after,
        provisional: {
          ...after.provisional,
          stableKey: state.subject.independentStableKey,
          lineageKey: state.subject.independentLineageKey,
        },
      };
    }
    afterByFindingId.set(state.finding.id, after);
    setFinalIntent(intentByFindingId, intentFor({
      after,
      expectedHead: state.subject.expectedHead,
      sourceSubjectIds: [state.subject.subjectId, ...absorbed.map(({ subject }) => subject.subjectId)],
      absorbedFindingIds: absorbed.map(({ finding }) => finding.id),
    }));
  }
  const releaseWitnesses: ProvisionalConflictReleaseWitness[] = holdings.flatMap((state) => {
    if (chosenAssociationByHolding.has(state.subject.subjectId)) return [];
    const candidateAssociationIds = binarySortedUnique(candidates.flatMap((candidate) => (
      candidate.sourceHoldingSubjectId === state.subject.subjectId ? [candidate.associationId] : []
    )));
    const payload = {
      normalizationSnapshotId: snapshot.normalizationSnapshotId,
      holdingSubjectId: state.subject.subjectId,
      candidateAssociationIds,
      proofUniverseDigest: proofUniverse.proofUniverseDigest,
    };
    return [{
      releaseWitnessId: computeProvisionalConflictReleaseWitnessId(payload),
      ...payload,
      provenAssociationIds: [] as [],
    }];
  });
  const releaseBySubject = new Map(releaseWitnesses.map((witness) => [witness.holdingSubjectId, witness]));
  const decisions = batch.states.map((state): ProvisionalConflictNormalizationDecision => {
    const intent = intentByFindingId.get(state.finding.id)!;
    if (state.subject.role === 'provisional_target') {
      return {
        conflictId: state.subject.conflictId,
        subjectId: state.subject.subjectId,
        subjectRole: 'provisional_target',
        findingId: state.finding.id,
        outcome: 'retained_provisional',
        finalIntentDigest: intent.intentDigest,
      };
    }
    const association = chosenAssociationByHolding.get(state.subject.subjectId);
    if (association !== undefined) {
      const finalTarget = finalTargetBySubjectId.get(state.subject.subjectId)!;
      return {
        conflictId: state.subject.conflictId,
        subjectId: state.subject.subjectId,
        subjectRole: 'holding_provisional',
        findingId: state.finding.id,
        outcome: 'bundled_into_provisional',
        targetSubjectId: association.targetSubjectId,
        targetFindingId: finalTarget.finding.id,
        associationId: association.associationId,
        proofRecordIds: [proofByAssociationId.get(association.associationId)!.proofId],
        sourceFinalIntentDigest: intent.intentDigest,
        targetFinalIntentDigest: intentByFindingId.get(finalTarget.finding.id)!.intentDigest,
      };
    }
    const witness = releaseBySubject.get(state.subject.subjectId)!;
    return {
      conflictId: state.subject.conflictId,
      subjectId: state.subject.subjectId,
      subjectRole: 'holding_provisional',
      findingId: state.finding.id,
      outcome: 'released_independent',
      independentClaimKey: state.subject.independentClaimKey,
      independentLineageKey: state.subject.independentLineageKey,
      independentStableKey: state.subject.independentStableKey,
      releaseWitnessId: witness.releaseWitnessId,
      proofRecordIds: [],
      finalIntentDigest: intent.intentDigest,
    };
  }).sort((a, b) => compareBinaryStrings(a.subjectId, b.subjectId));
  const finalFindingIntents = [...intentByFindingId.values()]
    .sort((a, b) => compareBinaryStrings(a.findingId, b.findingId));
  const fingerprintWithoutDigest = {
    conflictIds: binarySortedUnique(batch.conflicts.map(({ id }) => id)),
    provisionalTargetFindingIds: binarySortedUnique(targets.map(({ finding }) => finding.id)),
    holdingFindingIds: binarySortedUnique(holdings.map(({ finding }) => finding.id)),
    holdingOwners: [...batch.holdingOwners].sort((a, b) => compareBinaryStrings(a.holdingFindingId, b.holdingFindingId)),
    verifiedIdentities: batch.states.map(({ identity }) => identity)
      .sort((a, b) => compareBinaryStrings(a.findingId, b.findingId)),
    finalFindingIntents,
  };
  const fingerprint: LegacyProvisionalConflictBatchFingerprint = {
    ...fingerprintWithoutDigest,
    fingerprintDigest: computeLegacyProvisionalConflictBatchFingerprintDigest(fingerprintWithoutDigest),
  };
  const decisionDigest = computeProvisionalConflictDecisionDigest({
    normalizationSnapshotId: snapshot.normalizationSnapshotId,
    decisions,
    releaseWitnessIds: releaseWitnesses.map(({ releaseWitnessId }) => releaseWitnessId),
  });
  const normalizationId = computeProvisionalConflictNormalizationId({
    normalizationSnapshotId: snapshot.normalizationSnapshotId,
    decisionDigest,
  });
  const finalFindingProjections = finalFindingIntents.map((intent) => {
    const after = afterByFindingId.get(intent.findingId)!;
    return {
      findingId: intent.findingId,
      intentDigest: intent.intentDigest,
      expectedHead: intent.expectedHead,
      after,
      projectionDigest: computeFindingLifecycleProjectionDigest(after),
    };
  });
  const record: ProvisionalConflictNormalizationRecord = {
    normalizationId,
    normalizationSnapshotId: snapshot.normalizationSnapshotId,
    batchFingerprintDigest: fingerprint.fingerprintDigest,
    decisionDigest,
    decisions,
    releaseWitnesses,
    finalFindingProjections,
    recordedAt: input.recordedAt,
  };
  const resolvedConflicts = batch.conflicts.map((conflict): FindingLedgerConflict => ({
    ...conflict,
    status: 'resolved',
    revision: conflict.revision + 1,
    resolvedAt: input.recordedAt.timestamp,
    resolvedEvidence: `Provisional conflict normalization ${normalizationId}`,
  }));
  ledger = {
    ...ledger,
    evidenceRecords: [...ledger.evidenceRecords, ...associationProofs],
    provisionalConflictNormalizationSnapshots: [snapshot],
    provisionalConflictNormalizations: [record],
  };
  const command: FindingLifecycleCommand = {
    operation: 'normalize_provisional_conflicts',
    changes: {
      findings: [...afterByFindingId.values()].map(withoutRevision),
      conflicts: resolvedConflicts.map((conflict) => {
        const { revision: _revision, ...projection } = conflict;
        void _revision;
        return projection;
      }),
    },
    authority: {
      kind: 'provisional_conflict_normalization',
      normalizationId,
      normalizationSnapshotId: snapshot.normalizationSnapshotId,
      decisionDigest,
    },
    evidenceSourcesByTarget: new Map(),
  };
  ledger = applyFindingLifecycleCommands({
    ledger,
    commands: [command],
    occurredAt: input.recordedAt,
  });
  const event = ledger.lifecycleEvents[ledger.lifecycleEvents.length - 1]!;
  const settlements: ProvisionalConflictNormalizationSettlement[] = decisions.map((decision) => {
    const state = stateBySubjectId.get(decision.subjectId)!;
    const base = {
      settlementId: computeProvisionalConflictNormalizationSettlementId({
        normalizationId,
        conflictId: decision.conflictId,
        subjectId: decision.subjectId,
      }),
      normalizationId,
      normalizationSnapshotId: snapshot.normalizationSnapshotId,
      conflictId: decision.conflictId,
      subjectId: decision.subjectId,
      findingId: decision.findingId,
      expectedHead: state.subject.expectedHead,
      rawClaimLandingIds: state.subject.rawClaimLandingIds,
      lifecycleEventIds: [event.eventId] as [string],
      recordedAt: input.recordedAt,
    };
    if (decision.outcome === 'retained_provisional') {
      return { ...base, subjectRole: 'provisional_target', outcome: decision.outcome, rawClaimLandingIds: [] };
    }
    if (decision.outcome === 'bundled_into_provisional') {
      return {
        ...base,
        subjectRole: 'holding_provisional',
        outcome: decision.outcome,
        targetFindingId: decision.targetFindingId,
        proofRecordIds: decision.proofRecordIds,
      };
    }
    return {
      ...base,
      subjectRole: 'holding_provisional',
      outcome: decision.outcome,
      releaseWitnessId: decision.releaseWitnessId,
      independentStableKey: decision.independentStableKey,
      proofRecordIds: [],
    };
  });
  ledger = {
    ...ledger,
    conflictClaimSettlements: [...ledger.conflictClaimSettlements, ...settlements],
  };
  return { ledger, snapshot, record, settlements, fingerprint };
}
