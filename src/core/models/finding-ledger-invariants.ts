import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import {
  computeConflictAttemptId,
  computeConflictClaimSettlementId,
  computeConflictClaimSubjectId,
  computeConflictEpisodeId,
  computeConflictHoldingAllocationId,
  computeConflictHoldingStableKey,
  computeConflictRawClaimLandingId,
  computeConflictRawClaimSnapshotDigest,
  computeConflictSnapshotId,
  computeFindingManagerBudgetScopeId,
  computeFindingManagerProviderCallId,
  computeFindingManagerRoundIdentity,
  computeFindingScopeBindingId,
  computeInterpretationCaseSnapshotId,
  computeInterpretationObservationDigest,
  computeInterpretationOriginBindingId,
  computeInterpretationOriginSettlementId,
  computeRawCanonicalSnapshotId,
  computeRawPayloadDigest,
  binarySortedUnique,
  computeLegacyProvisionalConflictBatchFingerprintDigest,
  computeProvisionalConflictDecisionDigest,
  computeProvisionalConflictFinalIntentDigest,
  computeProvisionalConflictAssociationId,
  computeProvisionalConflictNormalizationId,
  computeProvisionalConflictNormalizationSettlementId,
  computeProvisionalConflictNormalizationSnapshotId,
  computeProvisionalConflictNormalizationSubjectId,
  computeProvisionalConflictProofUniverseDigest,
  computeProvisionalConflictReleaseWitnessId,
  computeRawProvisionalExactClaimIdentityDigest,
  computeTerminalAttemptId,
  computeTerminalEpisodeId,
  computeTerminalSelectionId,
  computeTerminalSettlementId,
  findingContentAddress,
} from './finding-contract-identity.js';
import { computeFindingLifecycleProjectionDigest } from './finding-lifecycle-identity.js';
import { findingScopeBindingDependencyViolation } from './finding-scope-binding-dependencies.js';
import { hasVerifiedOrdinaryLifecycleCoverage } from './finding-lifecycle-continuity.js';
import type {
  FindingContractLedgerRegistries,
  ProvisionalConflictNormalizationDecision,
  ProvisionalConflictNormalizationFinalFindingIntent,
  ProvisionalConflictNormalizationFinalFindingProjection,
  ProvisionalConflictNormalizationSnapshot,
  RawCanonicalSnapshot,
} from './finding-contract-types.js';
import { formatConflictId, type ConflictIdentity } from './finding-conflict-identity.js';
import { computeInterpretationAttemptId } from './finding-interpretation-identity.js';
import {
  reviewerAnomalySettlementEligibilityViolation,
} from './finding-reviewer-anomaly-settlement-policy.js';
import {
  INTAKE_CONTRACT_ANOMALY_REASON_CODES,
  INTAKE_CONTRACT_MISSING_REQUIREMENTS,
} from './finding-types.js';
import type {
  FindingEvidenceBinding,
  FindingEvidenceRecord,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingLifecycleEvent,
  FindingLifecycleReservation,
  RawFinding,
  ReviewerAnomalyEntry,
} from './finding-types.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

type ReadonlyContractRegistries = {
  readonly [Key in keyof FindingContractLedgerRegistries]: Readonly<
    FindingContractLedgerRegistries[Key]
  >;
};

type ReclassificationSettlement = Extract<
  FindingContractLedgerRegistries['terminalAdjudicationSettlements'][number],
  { outcome: 'reclassified_to_reviewer_anomaly' }
>;

export type FindingLedgerProjectionInvariantInput = ReadonlyContractRegistries & {
  nextId: number;
  findings: readonly FindingLedgerEntry[];
  evidenceRecords: readonly FindingEvidenceRecord[];
  evidenceBindings: readonly FindingEvidenceBinding[];
  lifecycleReservations: readonly FindingLifecycleReservation[];
  lifecycleEvents: readonly FindingLifecycleEvent[];
  rawFindings: readonly RawFinding[];
  conflicts: readonly (ConflictIdentity & FindingLedgerConflict)[];
  reviewerAnomalies?: readonly ReviewerAnomalyEntry[];
};

export interface FindingLedgerProjectionInvariantViolation {
  path: Array<string | number>;
  message: string;
}

type Violation = FindingLedgerProjectionInvariantViolation;

function addViolation(
  violations: Violation[],
  path: Array<string | number>,
  message: string,
): void {
  violations.push({ path, message });
}

function collectDuplicateIds<Value>(input: {
  values: readonly Value[];
  registry: string;
  idOf: (value: Value) => string;
  violations: Violation[];
}): Map<string, Value> {
  const valuesById = new Map<string, Value>();
  input.values.forEach((value, index) => {
    const id = input.idOf(value);
    if (valuesById.has(id)) {
      addViolation(
        input.violations,
        [input.registry, index],
        input.registry === 'findings'
          ? `Duplicate finding id "${id}"`
          : `Duplicate ${input.registry} identity "${id}"`,
      );
    }
    valuesById.set(id, value);
  });
  return valuesById;
}

function isBinarySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => (
    index === 0 || compareBinaryStrings(values[index - 1]!, value) < 0
  ));
}

function requireSortedSet(
  values: readonly string[],
  path: Array<string | number>,
  violations: Violation[],
): void {
  if (!isBinarySortedUnique(values)) {
    addViolation(violations, path, 'ID set must be binary-sorted and duplicate-free');
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort(compareBinaryStrings))
    === canonicalJson([...right].sort(compareBinaryStrings));
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function collectCoreViolations(
  projection: FindingLedgerProjectionInvariantInput,
  violations: Violation[],
): {
  rawById: Map<string, RawFinding>;
  findingsById: Map<string, FindingLedgerEntry>;
} {
  const evidenceIds = collectDuplicateIds({
    values: projection.evidenceRecords,
    registry: 'evidenceRecords',
    idOf: (record) => record.evidenceId,
    violations,
  });
  const findingsById = collectDuplicateIds({
    values: projection.findings,
    registry: 'findings',
    idOf: (finding) => finding.id,
    violations,
  });
  let maxFindingId = 0;
  projection.findings.forEach((finding, index) => {
    const match = FINDING_ID_PATTERN.exec(finding.id);
    if (match === null) {
      addViolation(violations, ['findings', index, 'id'], `Invalid finding id "${finding.id}"`);
    } else {
      maxFindingId = Math.max(maxFindingId, Number(match[1]));
    }
    finding.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        addViolation(
          violations,
          ['findings', index, 'evidenceIds', evidenceIndex],
          `Finding "${finding.id}" references unknown evidence "${evidenceId}"`,
        );
      }
    });
  });
  projection.findings.forEach((finding, index) => {
    if (finding.status !== 'superseded' || finding.supersededByFindingId === undefined) {
      return;
    }
    const canonical = findingsById.get(finding.supersededByFindingId);
    if (canonical === undefined) {
      addViolation(
        violations,
        ['findings', index, 'supersededByFindingId'],
        `Superseded finding "${finding.id}" references unknown canonical finding "${finding.supersededByFindingId}"`,
      );
      return;
    }
    const canonicalEvidenceIds = new Set(canonical.evidenceIds);
    const missingEvidenceId = finding.evidenceIds.find(
      (evidenceId) => !canonicalEvidenceIds.has(evidenceId),
    );
    if (missingEvidenceId !== undefined) {
      addViolation(
        violations,
        ['findings', index, 'evidenceIds'],
        `Superseded finding "${finding.id}" evidence id "${missingEvidenceId}" must also be referenced by canonical finding "${canonical.id}"`,
      );
    }
  });
  if (projection.nextId <= maxFindingId) {
    addViolation(
      violations,
      ['nextId'],
      `Finding ledger nextId ${projection.nextId} must be greater than existing finding id F-${String(maxFindingId).padStart(4, '0')}`,
    );
  }
  projection.conflicts.forEach((conflict, index) => {
    const canonicalId = formatConflictId(conflict);
    if (conflict.id !== canonicalId) {
      addViolation(
        violations,
        ['conflicts', index, 'id'],
        `Conflict id "${conflict.id}" must equal its canonical content-derived id "${canonicalId}"`,
      );
    }
  });
  const rawById = collectDuplicateIds({
    values: projection.rawFindings,
    registry: 'rawFindings',
    idOf: (raw) => raw.rawFindingId,
    violations,
  });
  return { rawById, findingsById };
}

function collectReclassificationViolations(
  projection: FindingLedgerProjectionInvariantInput,
  rawById: ReadonlyMap<string, RawFinding>,
  violations: Violation[],
): void {
  projection.findings.forEach((finding, index) => {
    const marker = finding.reviewerAnomalyReclassification;
    if (marker === undefined) {
      return;
    }
    const anomaly = (projection.reviewerAnomalies ?? []).find(
      (candidate) => candidate.id === marker.anomalyId,
    );
    const oldHeadMatches = marker.oldHead.entityKind === 'finding'
      && marker.oldHead.entityId === finding.id
      && projection.lifecycleEvents.some((event) => (
        event.eventId === marker.oldHead.eventId
        && event.transitions.some((transition) => (
          transition.after.entityKind === 'finding'
            && transition.after.entityId === finding.id
            && sameValue(transition.after, marker.oldHead)
        ))
      ));
    const provisionalRawIds = finding.provisional?.sourceRawFindingIds ?? [];
    const sourceRawIdsValid = sameValue(
      marker.rawFindingIds,
      provisionalRawIds,
    ) && marker.rawFindingIds.every((rawFindingId) => rawById.has(rawFindingId));
    const anomalyBindingValid = anomaly !== undefined
      && sameValue(anomaly.sourceRawFindingIds, marker.rawFindingIds);
    const reclassificationSettlements = projection.terminalAdjudicationSettlements.filter(
      (settlement): settlement is ReclassificationSettlement => (
        settlement.outcome === 'reclassified_to_reviewer_anomaly'
          && settlement.migrationId === marker.migrationId
          && settlement.provisionalFindingId === finding.id
      ),
    );
    const settlementEpisodeIds = reclassificationSettlements.map(({ episodeId }) => episodeId);
    const settlementAttemptIds = reclassificationSettlements.flatMap(({ attemptIds }) => attemptIds);
    const settlementsValid = sameSet(marker.terminalEpisodeIds, settlementEpisodeIds)
      && sameSet(marker.terminalAttemptIds, settlementAttemptIds)
      && reclassificationSettlements.every((settlement) => (
        sameSet(settlement.scopeBindingIds, marker.scopeBindingIds)
      ));
    const terminalEpisodeRefsValid = marker.terminalEpisodeIds.every((episodeId) => {
      const episode = projection.terminalAdjudicationEpisodes.find(
        (candidate) => candidate.episodeId === episodeId,
      );
      return episode?.findingId === finding.id;
    });
    const terminalAttemptRefsValid = marker.terminalAttemptIds.every((attemptId) => {
      const attempt = projection.terminalAdjudicationAttempts.find(
        (candidate) => candidate.attemptId === attemptId,
      );
      return attempt !== undefined
        && attempt.findingId === finding.id
        && marker.terminalEpisodeIds.includes(attempt.episodeId);
    });
    const bindingReferences = projection.evidenceRecords.flatMap((record) => (
      record.kind === 'engine_proof'
        && record.subject.kind === 'finding_provisional_isolation'
        && record.subject.findingId === finding.id
        ? record.subject.claimBindingAuthorizationReferences
        : []
    ));
    const bindingIdsValid = marker.bindingAuthorizationIds.every((authorizationId) => (
      bindingReferences.some((reference) => reference.authorizationId === authorizationId)
    ));
    const decisionIdsValid = marker.bindingDecisionIds.every((bindingDecisionId) => (
      bindingReferences.some((reference) => reference.bindingDecisionId === bindingDecisionId)
    ));
    const allowlistBMetadataRequired = finding.provisional?.kind === 'raw-adjudication-unresolved'
      || marker.bindingAuthorizationIds.length > 0
      || marker.bindingDecisionIds.length > 0;
    const allowlistBMetadataValid = allowlistBMetadataRequired
      ? marker.bindingAuthorizationIds.length === 1
        && marker.bindingDecisionIds.length === 1
        && bindingReferences.some((reference) => (
          reference.kind === 'new_provisional_bundle'
            && reference.authorizationId === marker.bindingAuthorizationIds[0]
            && reference.bindingDecisionId === marker.bindingDecisionIds[0]
            && sameSet(reference.sourceRawFindingIds, marker.rawFindingIds)
        ))
      : true;
    const sourceSnapshots = projection.rawCanonicalSnapshots.filter((snapshot) => (
      marker.rawFindingIds.includes(snapshot.rawFindingId)
    ));
    const rawCanonicalSnapshotsValid = sourceSnapshots.length === marker.rawFindingIds.length
      && sameSet(
        marker.rawCanonicalSnapshotIds,
        sourceSnapshots.map(({ rawCanonicalSnapshotId }) => rawCanonicalSnapshotId),
      );
    const scopeBindingsForMigration = projection.findingScopeBindings.filter((binding) => (
      binding.findingId === finding.id
    ));
    const scopeBindingIdsValid = marker.scopeBindingIds.every((bindingId) => (
      scopeBindingsForMigration.some((binding) => binding.bindingId === bindingId)
    )) && sameSet(
      marker.scopeBindingIds,
      scopeBindingsForMigration.map(({ bindingId }) => bindingId),
    );
    if (
      !oldHeadMatches
      || !sourceRawIdsValid
      || !anomalyBindingValid
      || !settlementsValid
      || !terminalEpisodeRefsValid
      || !terminalAttemptRefsValid
      || !bindingIdsValid
      || !decisionIdsValid
      || !allowlistBMetadataValid
      || !isBinarySortedUnique(marker.rawFindingIds)
      || !isBinarySortedUnique(marker.rawCanonicalSnapshotIds)
      || !isBinarySortedUnique(marker.terminalEpisodeIds)
      || !isBinarySortedUnique(marker.terminalAttemptIds)
      || !isBinarySortedUnique(marker.scopeBindingIds)
      || !isBinarySortedUnique(marker.bindingAuthorizationIds)
      || !isBinarySortedUnique(marker.bindingDecisionIds)
      || marker.bindingAuthorizationIds.length !== marker.bindingDecisionIds.length
      || !rawCanonicalSnapshotsValid
      || !scopeBindingIdsValid
    ) {
      addViolation(
        violations,
        ['findings', index, 'reviewerAnomalyReclassification'],
        `Finding "${finding.id}" has an invalid intake reclassification marker`,
      );
    }
  });
}

function collectRawSnapshotViolations(
  projection: FindingLedgerProjectionInvariantInput,
  rawById: ReadonlyMap<string, RawFinding>,
  violations: Violation[],
): Map<string, FindingContractLedgerRegistries['rawCanonicalSnapshots'][number]> {
  const snapshotsByRawId = new Map<
    string,
    FindingContractLedgerRegistries['rawCanonicalSnapshots'][number]
  >();
  collectDuplicateIds({
    values: projection.rawCanonicalSnapshots,
    registry: 'rawCanonicalSnapshots',
    idOf: (snapshot) => snapshot.rawCanonicalSnapshotId,
    violations,
  });
  projection.rawCanonicalSnapshots.forEach((snapshot, index) => {
    if (snapshotsByRawId.has(snapshot.rawFindingId)) {
      addViolation(
        violations,
        ['rawCanonicalSnapshots', index, 'rawFindingId'],
        `Raw finding "${snapshot.rawFindingId}" has multiple canonical snapshots`,
      );
    }
    const raw = rawById.get(snapshot.rawFindingId);
    if (raw === undefined) {
      addViolation(
        violations,
        ['rawCanonicalSnapshots', index, 'rawFindingId'],
        `Canonical snapshot references missing raw finding "${snapshot.rawFindingId}"`,
      );
    } else if (snapshot.rawPayloadDigest !== computeRawPayloadDigest(raw)) {
      addViolation(
        violations,
        ['rawCanonicalSnapshots', index, 'rawPayloadDigest'],
        `Canonical snapshot for "${snapshot.rawFindingId}" has a payload digest mismatch`,
      );
    }
    requireSortedSet(
      snapshot.captureDependencyDigests,
      ['rawCanonicalSnapshots', index, 'captureDependencyDigests'],
      violations,
    );
    if (snapshot.rawCanonicalSnapshotId !== computeRawCanonicalSnapshotId(snapshot)) {
      addViolation(
        violations,
        ['rawCanonicalSnapshots', index, 'rawCanonicalSnapshotId'],
        `Canonical snapshot for "${snapshot.rawFindingId}" has an invalid identity`,
      );
    }
    snapshotsByRawId.set(snapshot.rawFindingId, snapshot);
  });
  for (const [rawFindingId] of rawById) {
    if (!snapshotsByRawId.has(rawFindingId)) {
      addViolation(
        violations,
        ['rawCanonicalSnapshots'],
        `Raw finding "${rawFindingId}" must have exactly one canonical snapshot`,
      );
    }
  }
  return snapshotsByRawId;
}

function collectInterpretationViolations(
  projection: FindingLedgerProjectionInvariantInput,
  rawById: ReadonlyMap<string, RawFinding>,
  snapshotsByRawId: ReadonlyMap<
    string,
    FindingContractLedgerRegistries['rawCanonicalSnapshots'][number]
  >,
  violations: Violation[],
): Set<string> {
  const caseSnapshotsById = collectDuplicateIds({
    values: projection.interpretationCaseSnapshots,
    registry: 'interpretationCaseSnapshots',
    idOf: (snapshot) => snapshot.caseSnapshotId,
    violations,
  });
  projection.interpretationCaseSnapshots.forEach((snapshot, index) => {
    requireSortedSet(
      snapshot.memberRawFindingIds,
      ['interpretationCaseSnapshots', index, 'memberRawFindingIds'],
      violations,
    );
    if (
      snapshot.memberRawFindingIds.length !== snapshot.memberObservationDigests.length
      || snapshot.caseSnapshotId !== computeInterpretationCaseSnapshotId(snapshot)
    ) {
      addViolation(
        violations,
        ['interpretationCaseSnapshots', index],
        `Interpretation case snapshot "${snapshot.caseSnapshotId}" has invalid content identity`,
      );
    }
  });
  const observationsByRawId = new Map<
    string,
    FindingContractLedgerRegistries['interpretationRawObservations'][number]
  >();
  const observationsByDigest = collectDuplicateIds({
    values: projection.interpretationRawObservations,
    registry: 'interpretationRawObservations',
    idOf: (observation) => observation.observationDigest,
    violations,
  });
  projection.interpretationRawObservations.forEach((observation, index) => {
    if (observationsByRawId.has(observation.rawFindingId)) {
      addViolation(
        violations,
        ['interpretationRawObservations', index, 'rawFindingId'],
        `Raw finding "${observation.rawFindingId}" has multiple interpretation observations`,
      );
    }
    const snapshot = snapshotsByRawId.get(observation.rawFindingId);
    const caseSnapshot = caseSnapshotsById.get(observation.caseSnapshotId);
    if (
      !rawById.has(observation.rawFindingId)
      || snapshot?.rawCanonicalSnapshotId !== observation.rawCanonicalSnapshotId
      || caseSnapshot === undefined
      || caseSnapshot.caseId !== observation.caseId
      || caseSnapshot.cohortId !== observation.cohortId
      || caseSnapshot.lineageKey !== observation.lineageKey
      || caseSnapshot.semanticProjectionDigest !== observation.semanticProjectionDigest
    ) {
      addViolation(
        violations,
        ['interpretationRawObservations', index],
        `Interpretation observation for "${observation.rawFindingId}" has invalid references`,
      );
    }
    requireSortedSet(
      observation.originSnapshotDigests,
      ['interpretationRawObservations', index, 'originSnapshotDigests'],
      violations,
    );
    requireSortedSet(
      observation.recoveryOriginBindingIds,
      ['interpretationRawObservations', index, 'recoveryOriginBindingIds'],
      violations,
    );
    if (observation.observationDigest !== computeInterpretationObservationDigest(observation)) {
      addViolation(
        violations,
        ['interpretationRawObservations', index, 'observationDigest'],
        `Interpretation observation for "${observation.rawFindingId}" has an invalid digest`,
      );
    }
    observationsByRawId.set(observation.rawFindingId, observation);
  });
  projection.interpretationCaseSnapshots.forEach((snapshot, index) => {
    const digests = snapshot.memberRawFindingIds.map(
      (rawFindingId) => observationsByRawId.get(rawFindingId)?.observationDigest,
    );
    if (
      digests.some((digest) => digest === undefined)
      || canonicalJson(digests) !== canonicalJson(snapshot.memberObservationDigests)
      || snapshot.memberObservationDigests.some((digest) => !observationsByDigest.has(digest))
    ) {
      addViolation(
        violations,
        ['interpretationCaseSnapshots', index, 'memberObservationDigests'],
        `Interpretation case snapshot "${snapshot.caseSnapshotId}" does not own its exact observations`,
      );
    }
  });
  const bindingsById = collectDuplicateIds({
    values: projection.interpretationRecoveryOriginBindings,
    registry: 'interpretationRecoveryOriginBindings',
    idOf: (binding) => binding.bindingId,
    violations,
  });
  projection.interpretationRecoveryOriginBindings.forEach((binding, index) => {
    const observation = observationsByRawId.get(binding.observationRawFindingId);
    if (
      binding.bindingId !== computeInterpretationOriginBindingId(binding)
      || caseSnapshotsById.get(binding.caseSnapshotId)?.caseId !== binding.caseId
      || observation?.caseSnapshotId !== binding.caseSnapshotId
      || !observation.recoveryOriginBindingIds.includes(binding.bindingId)
      || !observation.originSnapshotDigests.includes(binding.originSnapshotDigest)
    ) {
      addViolation(
        violations,
        ['interpretationRecoveryOriginBindings', index],
        `Interpretation origin binding "${binding.bindingId}" is invalid`,
      );
    }
  });
  const settledBindingIds = new Set<string>();
  collectDuplicateIds({
    values: projection.interpretationRecoveryOriginSettlements,
    registry: 'interpretationRecoveryOriginSettlements',
    idOf: (settlement) => settlement.settlementId,
    violations,
  });
  projection.interpretationRecoveryOriginSettlements.forEach((settlement, index) => {
    const binding = bindingsById.get(settlement.bindingId);
    if (
      settlement.settlementId !== computeInterpretationOriginSettlementId(settlement.bindingId)
      || binding === undefined
      || binding.caseSnapshotId !== settlement.caseSnapshotId
      || binding.originFindingId !== settlement.originFindingId
      || binding.originSnapshotDigest !== settlement.originSnapshotDigest
    ) {
      addViolation(
        violations,
        ['interpretationRecoveryOriginSettlements', index],
        `Interpretation origin settlement "${settlement.settlementId}" is invalid`,
      );
    }
    settledBindingIds.add(settlement.bindingId);
  });
  const activeOriginOwners = new Set<string>();
  projection.interpretationRecoveryOriginBindings.forEach((binding, index) => {
    if (settledBindingIds.has(binding.bindingId)) return;
    if (activeOriginOwners.has(binding.originFindingId)) {
      addViolation(
        violations,
        ['interpretationRecoveryOriginBindings', index, 'originFindingId'],
        `Origin finding "${binding.originFindingId}" has multiple active bindings`,
      );
    }
    activeOriginOwners.add(binding.originFindingId);
  });
  return new Set(caseSnapshotsById.keys());
}

function collectProviderAndAttemptViolations(
  projection: FindingLedgerProjectionInvariantInput,
  caseSnapshotIds: ReadonlySet<string>,
  violations: Violation[],
): void {
  const scopesById = collectDuplicateIds({
    values: projection.findingManagerProviderBudgetScopes,
    registry: 'findingManagerProviderBudgetScopes',
    idOf: (scope) => scope.budgetScopeId,
    violations,
  });
  const scopeByRound = new Map<string, string>();
  projection.findingManagerProviderBudgetScopes.forEach((scope, index) => {
    if (
      scope.roundIdentity !== computeFindingManagerRoundIdentity(scope)
      || scope.budgetScopeId !== computeFindingManagerBudgetScopeId(scope.roundIdentity)
    ) {
      addViolation(
        violations,
        ['findingManagerProviderBudgetScopes', index, 'budgetScopeId'],
        `Provider budget scope "${scope.budgetScopeId}" has an invalid identity`,
      );
    }
    if (scopeByRound.has(scope.roundIdentity)) {
      addViolation(
        violations,
        ['findingManagerProviderBudgetScopes', index, 'roundIdentity'],
        `Logical round "${scope.roundIdentity}" has multiple budget scopes`,
      );
    }
    scopeByRound.set(scope.roundIdentity, scope.budgetScopeId);
  });
  const attemptsById = new Map<string, { kind: string; providerCallId: string; stage: string }>();
  const registerAttempt = (
    attemptId: string,
    kind: string,
    providerCallId: string,
    stage: string,
    path: Array<string | number>,
  ): void => {
    if (attemptsById.has(attemptId)) {
      addViolation(violations, path, `Attempt id "${attemptId}" is not globally unique`);
    }
    attemptsById.set(attemptId, { kind, providerCallId, stage });
  };
  projection.interpretationAttempts.forEach((attempt, index) => {
    if (
      !caseSnapshotIds.has(attempt.caseSnapshotId)
      || attempt.attemptId !== computeInterpretationAttemptId(
        attempt.caseSnapshotId,
        attempt.attemptOrdinal,
        attempt.retryOrdinal,
      )
    ) {
      addViolation(
        violations,
        ['interpretationAttempts', index],
        `Interpretation attempt "${attempt.attemptId}" has an invalid identity`,
      );
    }
    requireSortedSet(
      attempt.rawFindingIds,
      ['interpretationAttempts', index, 'rawFindingIds'],
      violations,
    );
    registerAttempt(
      attempt.attemptId,
      'interpretation',
      attempt.providerCallId,
      attempt.stage,
      ['interpretationAttempts', index, 'attemptId'],
    );
  });
  const interpretationAttemptsByCaseSnapshot = new Map<
    string,
    typeof projection.interpretationAttempts
  >();
  projection.interpretationAttempts.forEach((attempt) => {
    const attempts = interpretationAttemptsByCaseSnapshot.get(attempt.caseSnapshotId) ?? [];
    interpretationAttemptsByCaseSnapshot.set(attempt.caseSnapshotId, [...attempts, attempt]);
  });
  for (const [caseSnapshotId, unorderedAttempts] of interpretationAttemptsByCaseSnapshot) {
    const attempts = [...unorderedAttempts].sort(
      (left, right) => left.retryOrdinal - right.retryOrdinal,
    );
    const first = attempts[0]!;
    const sequenceValid = attempts.length <= 2
      && attempts.every((attempt, index) => (
        attempt.retryOrdinal === index
        && attempt.attemptOrdinal === first.attemptOrdinal
        && attempt.caseId === first.caseId
        && attempt.cohortId === first.cohortId
        && attempt.lineageKey === first.lineageKey
        && attempt.semanticProjectionDigest === first.semanticProjectionDigest
        && sameSet(attempt.rawFindingIds, first.rawFindingIds)
        && (index === 0 || attempts[index - 1]?.stage === 'interrupted')
      ))
      && attempts.slice(0, -1).every((attempt) => attempt.stage === 'interrupted');
    if (!sequenceValid) {
      addViolation(
        violations,
        ['interpretationAttempts'],
        `Interpretation case snapshot "${caseSnapshotId}" has invalid retry continuity`,
      );
    }
  }
  projection.terminalAdjudicationAttempts.forEach((attempt, index) => {
    if (
      attempt.retryOrdinal !== attempt.attemptOrdinal - 1
      || attempt.attemptId !== computeTerminalAttemptId(attempt)
    ) {
      addViolation(
        violations,
        ['terminalAdjudicationAttempts', index],
        `Terminal attempt "${attempt.attemptId}" has an invalid identity`,
      );
    }
    registerAttempt(
      attempt.attemptId,
      'terminal_adjudication',
      attempt.providerCallId,
      attempt.stage,
      ['terminalAdjudicationAttempts', index, 'attemptId'],
    );
  });
  projection.conflictAdjudicationAttempts.forEach((attempt, index) => {
    if (
      attempt.retryOrdinal !== attempt.attemptOrdinal - 1
      || attempt.attemptId !== computeConflictAttemptId(attempt)
    ) {
      addViolation(
        violations,
        ['conflictAdjudicationAttempts', index],
        `Conflict attempt "${attempt.attemptId}" has an invalid identity`,
      );
    }
    registerAttempt(
      attempt.attemptId,
      'conflict_adjudication',
      attempt.providerCallId,
      attempt.stage,
      ['conflictAdjudicationAttempts', index, 'attemptId'],
    );
  });
  const callsById = collectDuplicateIds({
    values: projection.findingManagerProviderCalls,
    registry: 'findingManagerProviderCalls',
    idOf: (call) => call.providerCallId,
    violations,
  });
  const ordinalsByScope = new Map<string, number[]>();
  projection.findingManagerProviderCalls.forEach((call, index) => {
    const scope = scopesById.get(call.budgetScopeId);
    const canonicalId = computeFindingManagerProviderCallId(call);
    if (
      scope === undefined
      || call.providerCallId !== canonicalId
      || call.ownerAttemptKind !== call.purpose
      || call.ownerAttemptId !== call.attemptIds[0]
      || (call.purpose !== 'interpretation' && call.attemptIds.length !== 1)
      || call.reservedInputTokens !== call.measuredAdapterVisibleInputTokens
      || call.requestByteLength > scope.limits.maxAdapterVisibleInputBytesPerCall
      || call.reservedOutputTokens !== scope.limits.maxOutputTokensPerCall
      || call.measuredAdapterVisibleInputTokens > call.reservedInputTokens
      || (call.state === 'settled'
        && ((call.resultKind === 'accepted') === (call.failurePhase !== undefined)))
      || (call.state === 'settled'
        && call.resultKind === 'interrupted_unknown'
        && call.failurePhase !== 'provider_result_unknown')
    ) {
      addViolation(
        violations,
        ['findingManagerProviderCalls', index],
        `Provider call "${call.providerCallId}" has invalid ownership or identity`,
      );
    }
    requireSortedSet(
      call.attemptIds,
      ['findingManagerProviderCalls', index, 'attemptIds'],
      violations,
    );
    call.attemptIds.forEach((attemptId) => {
      const attempt = attemptsById.get(attemptId);
      if (
        attempt?.kind !== call.purpose
        || attempt.providerCallId !== call.providerCallId
      ) {
        addViolation(
          violations,
          ['findingManagerProviderCalls', index, 'attemptIds'],
          `Provider call "${call.providerCallId}" references an incompatible attempt`,
        );
      }
    });
    const ordinals = ordinalsByScope.get(call.budgetScopeId) ?? [];
    ordinals.push(call.callOrdinal);
    ordinalsByScope.set(call.budgetScopeId, ordinals);
  });
  for (const [scopeId, ordinals] of ordinalsByScope) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      addViolation(
        violations,
        ['findingManagerProviderCalls'],
        `Provider budget scope "${scopeId}" has non-contiguous call ordinals`,
      );
    }
  }
  for (const [attemptId, attempt] of attemptsById) {
    const call = callsById.get(attempt.providerCallId);
    const staleTerminalClosure = projection.terminalAdjudicationAttempts.some((candidate) => (
      candidate.attemptId === attemptId
      && candidate.stage === 'completed'
      && candidate.result.kind === 'stale_precondition'
      && projection.terminalAdjudicationSettlements.some((settlement) => (
        settlement.outcome === 'exhausted'
        && settlement.attemptId === candidate.attemptId
      ))
    ));
    if (call === undefined || !call.attemptIds.includes(attemptId)) {
      addViolation(
        violations,
        ['findingManagerProviderCalls'],
        `Attempt "${attemptId}" has no exact provider call lease`,
      );
    }
    if (
      call !== undefined
      && (
        (call.state !== 'settled' && attempt.stage !== 'started')
        || (call.state === 'settled'
          && call.resultKind === 'interrupted_unknown'
          && attempt.stage !== 'interrupted'
          && !staleTerminalClosure)
        || (call.state === 'settled'
          && call.resultKind !== 'interrupted_unknown'
          && attempt.stage === 'started')
      )
    ) {
      addViolation(
        violations,
        ['findingManagerProviderCalls'],
        `Attempt "${attemptId}" stage is incompatible with its provider call state`,
      );
    }
  }
}

function collectOutcomeViolations(
  projection: FindingLedgerProjectionInvariantInput,
  violations: Violation[],
): void {
  const observations = new Map(
    projection.interpretationRawObservations.map((observation) => [
      observation.rawFindingId,
      observation,
    ]),
  );
  const attempts = new Map(
    projection.interpretationAttempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const outcomesByRawId = new Map<string, typeof projection.rawInterpretationOutcomes[number]>();
  projection.rawInterpretationOutcomes.forEach((outcome, index) => {
    const rawFindingId = outcome.rawFindingId;
    if (outcomesByRawId.has(rawFindingId) || !observations.has(rawFindingId)) {
      addViolation(
        violations,
        ['rawInterpretationOutcomes', index],
        `Interpretation outcome for "${rawFindingId}" is duplicate or unobserved`,
      );
    }
    switch (outcome.kind) {
      case 'pending_attempt': {
        const attempt = attempts.get(outcome.attemptId);
        if (
          attempt === undefined
          || (attempt.stage !== 'started' && attempt.stage !== 'completed')
          || !attempt.rawFindingIds.includes(outcome.rawFindingId)
        ) {
          addViolation(
            violations,
            ['rawInterpretationOutcomes', index, 'attemptId'],
            `Pending outcome for "${outcome.rawFindingId}" has no active owner`,
          );
        }
        break;
      }
      case 'finding':
      case 'provisional':
      case 'conflict':
      case 'reviewer_anomaly':
        break;
      default:
        addViolation(
          violations,
          ['rawInterpretationOutcomes', index, 'kind'],
          `Interpretation outcome for "${rawFindingId}" has an unknown kind`,
        );
    }
    outcomesByRawId.set(rawFindingId, outcome);
  });
  for (const [rawFindingId] of observations) {
    if (!outcomesByRawId.has(rawFindingId)) {
      addViolation(
        violations,
        ['rawInterpretationOutcomes'],
        `Interpretation observation for "${rawFindingId}" has no exact outcome`,
      );
    }
  }
  projection.interpretationAttempts.forEach((attempt, index) => {
    for (const rawFindingId of attempt.rawFindingIds) {
      const outcome = outcomesByRawId.get(rawFindingId);
      if (
        attempt.stage === 'started'
        && (outcome?.kind !== 'pending_attempt' || outcome.attemptId !== attempt.attemptId)
      ) {
        addViolation(
          violations,
          ['interpretationAttempts', index],
          `Started interpretation attempt "${attempt.attemptId}" does not own every pending outcome`,
        );
      }
      if (attempt.stage === 'applied' && (outcome === undefined || outcome.kind === 'pending_attempt')) {
        addViolation(
          violations,
          ['interpretationAttempts', index],
          `Applied interpretation attempt "${attempt.attemptId}" has a non-terminal outcome`,
        );
      }
    }
  });
}

interface ReconstructedNormalizationSubjectClaim {
  rawFindingIds: string[];
  reviewerIds: string[];
  evidenceIds: string[];
}

function reconstructNormalizationSubjectClaim(input: {
  projection: FindingLedgerProjectionInvariantInput;
  subject: ProvisionalConflictNormalizationSnapshot['subjects'][number];
}): ReconstructedNormalizationSubjectClaim | null {
  const { subject } = input;
  if (
    subject.targetIdentityHash === null
    || subject.claimIdentityHash === null
    || subject.semanticClaimIdentityHash === null
    || subject.sourceRawFindingIds.length === 0
    || binarySortedUnique(subject.sourceRawFindingIds).length !== subject.sourceRawFindingIds.length
  ) {
    return null;
  }
  const raws: RawFinding[] = [];
  const snapshots: RawCanonicalSnapshot[] = [];
  for (const rawFindingId of subject.sourceRawFindingIds) {
    const matchingRaws = input.projection.rawFindings.filter(
      (raw) => raw.rawFindingId === rawFindingId,
    );
    const matchingSnapshots = input.projection.rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === rawFindingId,
    );
    if (matchingRaws.length !== 1 || matchingSnapshots.length !== 1) {
      return null;
    }
    const raw = matchingRaws[0]!;
    const snapshot = matchingSnapshots[0]!;
    if (
      snapshot.targetIdentityHash !== subject.targetIdentityHash
      || snapshot.claimIdentityHash !== subject.claimIdentityHash
      || snapshot.semanticClaimIdentityHash !== subject.semanticClaimIdentityHash
      || computeConflictRawClaimSnapshotDigest(snapshot) !== subject.claimSnapshotDigest
    ) {
      return null;
    }
    raws.push(raw);
    snapshots.push(snapshot);
  }
  const payloadDigests = snapshots.map((snapshot) => snapshot.rawPayloadDigest);
  if (
    payloadDigests.length !== subject.sourceRawPayloadDigests.length
    || !sameSet(payloadDigests, subject.sourceRawPayloadDigests)
  ) {
    return null;
  }
  const bindings = subject.evidenceBindingIds.map((bindingId) => {
    const matches = input.projection.evidenceBindings.filter(
      (binding) => binding.bindingId === bindingId,
    );
    return matches.length === 1 ? matches[0]! : null;
  });
  if (bindings.some((binding) => (
    binding === null
    || binding.target.entityKind !== 'finding'
    || binding.target.entityId !== subject.findingId
  ))) {
    return null;
  }
  const evidenceIds = binarySortedUnique(bindings.map((binding) => binding!.evidenceId));
  if (subject.evidenceSetDigest !== findingContentAddress('conflict-subject-evidence-set', {
    findingId: subject.findingId,
    evidenceBindingIds: binarySortedUnique(subject.evidenceBindingIds),
    evidenceIds,
  })) {
    return null;
  }
  return {
    rawFindingIds: binarySortedUnique(subject.sourceRawFindingIds),
    reviewerIds: binarySortedUnique(raws.map((raw) => raw.reviewer)),
    evidenceIds,
  };
}

function reconstructNormalizationFinalIntent(input: {
  ledgerProjection: FindingLedgerProjectionInvariantInput;
  snapshot: ProvisionalConflictNormalizationSnapshot;
  decisions: readonly ProvisionalConflictNormalizationDecision[];
  projection: ProvisionalConflictNormalizationFinalFindingProjection;
}): ProvisionalConflictNormalizationFinalFindingIntent | null {
  const subjects = input.snapshot.subjects.filter(
    (subject) => subject.findingId === input.projection.findingId,
  );
  if (subjects.length !== 1) {
    return null;
  }
  const ownSubject = subjects[0]!;
  const after = input.projection.after;
  if (after.status === 'superseded') {
    if (after.supersededByFindingId === undefined || after.lifecycle !== 'superseded') {
      return null;
    }
    const withoutDigest = {
      kind: 'superseded' as const,
      findingId: after.id,
      expectedHead: ownSubject.expectedHead,
      sourceSubjectIds: [ownSubject.subjectId],
      afterRevision: after.revision,
      afterLifecycle: 'superseded' as const,
      supersededByFindingId: after.supersededByFindingId,
      provisionalAfter: null as null,
    };
    return {
      ...withoutDigest,
      intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest),
    };
  }
  if (after.status !== 'open' || after.lifecycle !== 'persists' || after.provisional === undefined) {
    return null;
  }
  const absorbedDecisions = input.decisions.filter((decision) => (
    decision.outcome === 'bundled_into_provisional'
    && decision.targetFindingId === after.id
  ));
  const sourceSubjectIds = binarySortedUnique([
    ownSubject.subjectId,
    ...absorbedDecisions.map((decision) => decision.subjectId),
  ]);
  const sourceClaims = sourceSubjectIds.map((subjectId) => {
    const sourceSubjects = input.snapshot.subjects.filter(
      (subject) => subject.subjectId === subjectId,
    );
    return sourceSubjects.length === 1
      ? reconstructNormalizationSubjectClaim({
          projection: input.ledgerProjection,
          subject: sourceSubjects[0]!,
        })
      : null;
  });
  if (sourceClaims.some((claim) => claim === null)) {
    return null;
  }
  const withoutDigest = {
    kind: 'open_provisional' as const,
    findingId: after.id,
    expectedHead: ownSubject.expectedHead,
    sourceSubjectIds,
    afterRevision: after.revision,
    afterLifecycle: 'persists' as const,
    stableKey: after.provisional.stableKey,
    lineageKey: after.provisional.lineageKey,
    rawFindingIds: binarySortedUnique([...new Set(
      sourceClaims.flatMap((claim) => claim!.rawFindingIds),
    )]),
    provisionalSourceRawFindingIds: binarySortedUnique(
      [...new Set(sourceClaims.flatMap((claim) => claim!.rawFindingIds))],
    ),
    reviewerIds: binarySortedUnique([...new Set(
      sourceClaims.flatMap((claim) => claim!.reviewerIds),
    )]),
    evidenceIds: binarySortedUnique([...new Set(
      sourceClaims.flatMap((claim) => claim!.evidenceIds),
    )]),
    absorbedFindingIds: binarySortedUnique(
      absorbedDecisions.map((decision) => decision.findingId),
    ),
  };
  return {
    ...withoutDigest,
    intentDigest: computeProvisionalConflictFinalIntentDigest(withoutDigest),
  };
}

function normalizationProjectionMatchesIntent(
  projection: ProvisionalConflictNormalizationFinalFindingProjection,
  intent: ProvisionalConflictNormalizationFinalFindingIntent,
): boolean {
  if (intent.kind === 'superseded') {
    return true;
  }
  const after = projection.after;
  return after.status === 'open'
    && after.provisional !== undefined
    && sameSet(after.rawFindingIds, intent.rawFindingIds)
    && sameSet(after.provisional.sourceRawFindingIds, intent.provisionalSourceRawFindingIds)
    && sameSet(after.reviewers, intent.reviewerIds)
    && sameSet(after.evidenceIds, intent.evidenceIds);
}

function recomputeNormalizationBatchFingerprint(input: {
  projection: FindingLedgerProjectionInvariantInput;
  snapshot: ProvisionalConflictNormalizationSnapshot;
  finalIntents: readonly ProvisionalConflictNormalizationFinalFindingIntent[];
}): string | null {
  const verifiedIdentities = input.snapshot.subjects.map((subject) => {
    const claim = reconstructNormalizationSubjectClaim({
      projection: input.projection,
      subject,
    });
    if (claim === null) {
      return null;
    }
    const canonicalSnapshotIds = subject.sourceRawFindingIds.map((rawFindingId) => (
      input.projection.rawCanonicalSnapshots.find(
        (snapshot) => snapshot.rawFindingId === rawFindingId,
      )!.rawCanonicalSnapshotId
    ));
    return {
      findingId: subject.findingId,
      role: subject.role,
      targetIdentityHash: subject.targetIdentityHash!,
      claimIdentityHash: subject.claimIdentityHash!,
      semanticClaimIdentityHash: subject.semanticClaimIdentityHash!,
      claimSnapshotDigest: subject.claimSnapshotDigest,
      rawFindingIds: binarySortedUnique(subject.sourceRawFindingIds),
      rawCanonicalSnapshotIds: binarySortedUnique(canonicalSnapshotIds as string[]),
    };
  });
  if (verifiedIdentities.some((identity) => identity === null)) {
    return null;
  }
  return computeLegacyProvisionalConflictBatchFingerprintDigest({
    conflictIds: input.snapshot.conflicts.map((conflict) => conflict.conflictId),
    provisionalTargetFindingIds: input.snapshot.subjects.flatMap((subject) => (
      subject.role === 'provisional_target' ? [subject.findingId] : []
    )),
    holdingFindingIds: input.snapshot.subjects.flatMap((subject) => (
      subject.role === 'holding_provisional' ? [subject.findingId] : []
    )),
    holdingOwners: input.snapshot.subjects.flatMap((subject) => (
      subject.role === 'holding_provisional'
        ? [{
            holdingFindingId: subject.findingId,
            conflictId: subject.conflictId,
            rawClaimLandingIds: binarySortedUnique(subject.rawClaimLandingIds),
          }]
        : []
    )),
    verifiedIdentities: verifiedIdentities as Array<NonNullable<(typeof verifiedIdentities)[number]>>,
    finalFindingIntents: input.finalIntents,
  });
}

function normalizationSnapshotBindingInvalid(
  projection: FindingLedgerProjectionInvariantInput,
  snapshot: ProvisionalConflictNormalizationSnapshot,
): boolean {
  const subjectsById = new Map(snapshot.subjects.map((subject) => [subject.subjectId, subject]));
  if (subjectsById.size !== snapshot.subjects.length) {
    return true;
  }
  for (const conflict of snapshot.conflicts) {
    const subjects = snapshot.subjects.filter((subject) => subject.conflictId === conflict.conflictId);
    if (
      !sameSet(
        conflict.provisionalTargetSubjectIds,
        subjects.flatMap((subject) => subject.role === 'provisional_target' ? [subject.subjectId] : []),
      )
      || !sameSet(
        conflict.holdingSubjectIds,
        subjects.flatMap((subject) => subject.role === 'holding_provisional' ? [subject.subjectId] : []),
      )
      || !sameSet(
        conflict.findingIds,
        subjects.flatMap((subject) => subject.role === 'provisional_target' ? [subject.findingId] : []),
      )
      || !sameSet(
        conflict.rawClaimLandingIds,
        subjects.flatMap((subject) => subject.rawClaimLandingIds),
      )
    ) {
      return true;
    }
  }
  const mechanicalAssociationIds: string[] = [];
  for (const candidate of snapshot.proofUniverse.candidateAssociations) {
    const source = subjectsById.get(candidate.sourceHoldingSubjectId);
    const target = subjectsById.get(candidate.targetSubjectId);
    const { associationId: _associationId, ...associationIdentity } = candidate;
    void _associationId;
    if (
      source?.role !== 'holding_provisional'
      || target?.role !== candidate.targetSubjectRole
      || candidate.associationId !== computeProvisionalConflictAssociationId(associationIdentity)
      || (candidate.basis === 'conflict_target'
        && (target.role !== 'provisional_target' || source.conflictId !== target.conflictId))
      || (candidate.basis === 'independent_key_collision'
        && (
          target.role !== 'holding_provisional'
          || source.independentStableKey !== target.independentStableKey
          || source.subjectId === target.subjectId
        ))
    ) {
      return true;
    }
    if (
      source.targetIdentityHash === target.targetIdentityHash
      && source.claimIdentityHash === target.claimIdentityHash
      && source.semanticClaimIdentityHash === target.semanticClaimIdentityHash
    ) {
      mechanicalAssociationIds.push(candidate.associationId);
    }
  }
  const proofAssociationIds: string[] = [];
  for (const proofRecordId of snapshot.proofUniverse.trustedProofRecordIds) {
    const records = projection.evidenceRecords.filter((record) => (
      record.kind === 'engine_proof' && record.proofId === proofRecordId
    ));
    const record = records[0];
    if (
      records.length !== 1
      || record?.kind !== 'engine_proof'
      || record.purpose !== 'lifecycle_authority'
      || record.verifierId !== snapshot.proofUniverse.trustedVerifierId
      || record.verifierVersion !== snapshot.proofUniverse.trustedVerifierVersion
      || record.subject.kind !== 'provisional_conflict_association_identical'
    ) {
      return true;
    }
    const proofSubject = record.subject;
    const candidate = snapshot.proofUniverse.candidateAssociations.find(
      (association) => association.associationId === proofSubject.associationId,
    );
    const source = candidate === undefined
      ? undefined
      : subjectsById.get(candidate.sourceHoldingSubjectId);
    const target = candidate === undefined
      ? undefined
      : subjectsById.get(candidate.targetSubjectId);
    if (
      candidate === undefined
      || source === undefined
      || target === undefined
      || proofSubject.sourceHoldingSubjectId !== source.subjectId
      || proofSubject.targetSubjectId !== target.subjectId
      || proofSubject.targetSubjectRole !== target.role
      || !sameValue(proofSubject.sourceExpectedHead, source.expectedHead)
      || !sameValue(proofSubject.targetExpectedHead, target.expectedHead)
      || proofSubject.sourceClaimSnapshotDigest !== source.claimSnapshotDigest
      || proofSubject.targetClaimSnapshotDigest !== target.claimSnapshotDigest
      || record.targetFindingId !== target.findingId
      || record.claimIdentityHash !== source.claimIdentityHash
      || source.targetIdentityHash === null
      || source.claimIdentityHash === null
      || source.semanticClaimIdentityHash === null
      || source.claimIdentityHash !== target.claimIdentityHash
      || !sameSet(record.dependencyDigests, [
        source.expectedHead.projectionDigest,
        target.expectedHead.projectionDigest,
        source.claimSnapshotDigest,
        target.claimSnapshotDigest,
      ].filter((digest, index, digests) => digests.indexOf(digest) === index))
      || proofSubject.exactClaimIdentityDigest
        !== computeRawProvisionalExactClaimIdentityDigest({
          targetIdentityHash: source.targetIdentityHash!,
          claimIdentityHash: source.claimIdentityHash!,
          semanticClaimIdentityHash: source.semanticClaimIdentityHash!,
        })
    ) {
      return true;
    }
    proofAssociationIds.push(candidate.associationId);
  }
  return !sameSet(
    snapshot.proofUniverse.mechanicalExactAssociationIds,
    mechanicalAssociationIds,
  ) || !sameSet(
    snapshot.proofUniverse.provenAssociationIds,
    binarySortedUnique([...new Set([...mechanicalAssociationIds, ...proofAssociationIds])]),
  );
}

function collectConflictAndTerminalIdentityViolations(
  projection: FindingLedgerProjectionInvariantInput,
  violations: Violation[],
): void {
  const conflictsById = new Map(projection.conflicts.map((conflict) => [conflict.id, conflict]));
  const landingsById = collectDuplicateIds({
    values: projection.conflictRawClaimLandings,
    registry: 'conflictRawClaimLandings',
    idOf: (landing) => landing.rawClaimLandingId,
    violations,
  });
  const landingByRawId = new Map<string, string>();
  const allocationMembers = new Map<string, string[]>();
  const allocationOwners = new Map<string, { conflictId: string; holdingFindingId: string }>();
  const allocationByHoldingId = new Map<string, string>();
  const activeHoldingOwners = new Map<string, string>();
  projection.conflictRawClaimLandings.forEach((landing, index) => {
    const conflict = conflictsById.get(landing.conflictId);
    const raw = projection.rawFindings.find((candidate) => candidate.rawFindingId === landing.rawFindingId);
    const snapshot = projection.rawCanonicalSnapshots.find(
      (candidate) => candidate.rawCanonicalSnapshotId === landing.rawCanonicalSnapshotId,
    );
    const holding = projection.findings.find((candidate) => candidate.id === landing.holdingFindingId);
    const event = projection.lifecycleEvents.find((candidate) => candidate.eventId === landing.landingEventId);
    if (
      landing.rawClaimLandingId !== computeConflictRawClaimLandingId(landing)
      || conflict === undefined
      || raw === undefined
      || snapshot?.rawFindingId !== landing.rawFindingId
      || snapshot.rawPayloadDigest !== landing.rawPayloadDigest
      || landing.claimSnapshotDigest !== computeConflictRawClaimSnapshotDigest(snapshot)
      || holding === undefined
      || event === undefined
      || event.transitions.every((transition) => (
        transition.after.entityKind !== 'finding'
        || transition.after.entityId !== landing.holdingFindingId
        || !sameValue(transition.after, landing.holdingHeadAfterLanding)
      ))
    ) {
      addViolation(
        violations,
        ['conflictRawClaimLandings', index],
        `Conflict raw landing "${landing.rawClaimLandingId}" has invalid identity or owner`,
      );
    }
    if (landingByRawId.has(landing.rawFindingId)) {
      addViolation(
        violations,
        ['conflictRawClaimLandings', index, 'rawFindingId'],
        `Raw finding "${landing.rawFindingId}" has multiple conflict owners`,
      );
    }
    landingByRawId.set(landing.rawFindingId, landing.rawClaimLandingId);
    const members = allocationMembers.get(landing.holdingAllocationId) ?? [];
    members.push(landing.rawClaimLandingId);
    allocationMembers.set(landing.holdingAllocationId, members);
    const allocationOwner = allocationOwners.get(landing.holdingAllocationId);
    if (
      allocationOwner !== undefined
      && (
        allocationOwner.conflictId !== landing.conflictId
        || allocationOwner.holdingFindingId !== landing.holdingFindingId
      )
    ) {
      addViolation(
        violations,
        ['conflictRawClaimLandings', index, 'holdingAllocationId'],
        `Conflict holding allocation "${landing.holdingAllocationId}" has multiple owners`,
      );
    } else {
      allocationOwners.set(landing.holdingAllocationId, {
        conflictId: landing.conflictId,
        holdingFindingId: landing.holdingFindingId,
      });
    }
    const holdingAllocationId = allocationByHoldingId.get(landing.holdingFindingId);
    if (
      holdingAllocationId !== undefined
      && holdingAllocationId !== landing.holdingAllocationId
    ) {
      addViolation(
        violations,
        ['conflictRawClaimLandings', index, 'holdingFindingId'],
        `Conflict holding "${landing.holdingFindingId}" belongs to multiple allocations`,
      );
    } else {
      allocationByHoldingId.set(landing.holdingFindingId, landing.holdingAllocationId);
    }
    const landingSettled = projection.conflictClaimSettlements.some((settlement) => (
      settlement.conflictId === landing.conflictId
      && settlement.subjectRole === 'holding_provisional'
      && settlement.rawClaimLandingIds.includes(landing.rawClaimLandingId)
    ));
    if (
      conflict?.status === 'active'
      && !landingSettled
      &&
      holding?.provisional !== undefined
      && holding.provisional.stableKey !== computeConflictHoldingStableKey({
        conflictId: landing.conflictId,
        holdingAllocationId: landing.holdingAllocationId,
        provisionalKind: holding.provisional.kind,
      })
    ) {
      addViolation(
        violations,
        ['conflictRawClaimLandings', index, 'holdingFindingId'],
        `Conflict holding "${landing.holdingFindingId}" has an invalid allocation stable key`,
      );
    }
    if (conflict?.status === 'active' && !landingSettled) {
      const owner = activeHoldingOwners.get(landing.holdingFindingId);
      if (owner !== undefined && owner !== landing.conflictId) {
        addViolation(
          violations,
          ['conflictRawClaimLandings', index, 'holdingFindingId'],
          `Conflict holding "${landing.holdingFindingId}" has multiple active conflict owners`,
        );
      }
      activeHoldingOwners.set(landing.holdingFindingId, landing.conflictId);
    }
  });
  for (const [allocationId, memberIds] of allocationMembers) {
    const first = landingsById.get(memberIds[0]!);
    if (
      first === undefined
      || allocationId !== computeConflictHoldingAllocationId(first.conflictId, memberIds)
    ) {
      addViolation(
        violations,
        ['conflictRawClaimLandings'],
        `Conflict holding allocation "${allocationId}" has invalid membership`,
      );
    }
  }
  projection.lifecycleReservations.forEach((reservation, index) => {
    if (
      reservation.operation !== 'reactivate_conflict'
      || reservation.authority.kind !== 'conflict_reactivation'
    ) {
      return;
    }
    const authority = reservation.authority;
    const reactivationEvent = projection.lifecycleEvents.find(
      (event) => event.reservationId === reservation.reservationId,
    );
    const claimsValid = authority.newRawClaims.every((claim) => {
      const landing = projection.conflictRawClaimLandings.find(
        (candidate) => candidate.rawClaimLandingId === claim.rawClaimLandingId,
      );
      return landing !== undefined
        && landing.conflictId === authority.conflictId
        && landing.rawFindingId === claim.rawFindingId
        && landing.rawCanonicalSnapshotId === claim.rawCanonicalSnapshotId
        && landing.rawPayloadDigest === claim.rawPayloadDigest
        && landing.claimSnapshotDigest === claim.claimSnapshotDigest
        && landing.holdingAllocationId === claim.holdingAllocationId
        && landing.holdingFindingId === claim.holdingFindingId;
    });
    if (
      reactivationEvent?.operation !== 'reactivate_conflict'
      || !reactivationEvent.transitions.some((transition) => (
        transition.after.entityKind === 'conflict'
        && transition.after.entityId === authority.conflictId
      ))
      || !claimsValid
    ) {
      addViolation(
        violations,
        ['lifecycleReservations', index, 'authority'],
        `Conflict reactivation "${authority.conflictId}" has incomplete claim landing coverage`,
      );
    }
  });
  projection.conflicts.forEach((conflict, index) => {
    const landingRawIds = projection.conflictRawClaimLandings
      .filter((landing) => landing.conflictId === conflict.id)
      .map((landing) => landing.rawFindingId);
    if (!sameSet(landingRawIds, conflict.rawFindingIds)) {
      addViolation(
        violations,
        ['conflicts', index, 'rawFindingIds'],
        `Conflict "${conflict.id}" raw claim universe has incomplete landing coverage`,
      );
    }
  });
  collectDuplicateIds({
    values: projection.conflictAdjudicationSnapshots,
    registry: 'conflictAdjudicationSnapshots',
    idOf: (snapshot) => snapshot.conflictSnapshotId,
    violations,
  });
  projection.conflictAdjudicationSnapshots.forEach((snapshot, index) => {
    snapshot.subjects.forEach((subject) => {
      if (subject.subjectId !== computeConflictClaimSubjectId(subject)) {
        addViolation(
          violations,
          ['conflictAdjudicationSnapshots', index, 'subjects'],
          `Conflict subject "${subject.subjectId}" has invalid identity`,
        );
      }
    });
    if (snapshot.conflictSnapshotId !== computeConflictSnapshotId(snapshot)) {
      addViolation(
        violations,
        ['conflictAdjudicationSnapshots', index, 'conflictSnapshotId'],
        `Conflict snapshot "${snapshot.conflictSnapshotId}" has invalid identity`,
      );
    }
  });
  projection.conflicts.forEach((conflict, index) => {
    if (conflict.status !== 'active') {
      return;
    }
    const currentHead = projection.lifecycleEvents.flatMap((event) => event.transitions)
      .filter((transition) => (
        transition.after.entityKind === 'conflict'
        && transition.after.entityId === conflict.id
      ))
      .at(-1)?.after;
    const rawClaimLandingIds = projection.conflictRawClaimLandings
      .filter((landing) => landing.conflictId === conflict.id)
      .map((landing) => landing.rawClaimLandingId);
    const priorSettlementIds = projection.conflictClaimSettlements
      .filter((settlement) => settlement.conflictId === conflict.id)
      .map((settlement) => settlement.settlementId);
    const settledProductFindingIds = projection.conflictClaimSettlements
      .filter((settlement) => (
        settlement.conflictId === conflict.id
        && settlement.subjectRole === 'product_finding'
      ))
      .map((settlement) => settlement.findingId);
    const settledRawClaimLandingIds = projection.conflictClaimSettlements
      .filter((settlement) => (
        settlement.conflictId === conflict.id
        && settlement.subjectRole === 'holding_provisional'
      ))
      .flatMap((settlement) => settlement.rawClaimLandingIds);
    const expectedProductFindingIds = conflict.findingIds.filter((findingId) => {
      const finding = projection.findings.find((candidate) => candidate.id === findingId);
      return !settledProductFindingIds.includes(findingId)
        && finding?.status === 'open'
        && finding.provisional === undefined;
    });
    const expectedHoldingLandingIds = rawClaimLandingIds.filter(
      (landingId) => !settledRawClaimLandingIds.includes(landingId),
    );
    const freshSnapshots = projection.conflictAdjudicationSnapshots.filter((snapshot) => (
      snapshot.conflictId === conflict.id
      && sameValue(snapshot.expectedConflictHead, currentHead)
      && sameSet(snapshot.rawClaimLandingIds, rawClaimLandingIds)
      && sameSet(snapshot.priorSettlementIds, priorSettlementIds)
      && sameSet(
        snapshot.subjects
          .filter((subject) => subject.role === 'product_finding')
          .map((subject) => subject.findingId),
        expectedProductFindingIds,
      )
      && sameSet(
        snapshot.subjects
          .filter((subject) => subject.role === 'holding_provisional')
          .flatMap((subject) => subject.rawClaimLandingIds),
        expectedHoldingLandingIds,
      )
      && snapshot.subjects.every((subject) => {
        const subjectHead = projection.lifecycleEvents.flatMap((event) => event.transitions)
          .filter((transition) => (
            transition.after.entityKind === 'finding'
            && transition.after.entityId === subject.findingId
          ))
          .at(-1)?.after;
        return sameValue(subject.expectedHead, subjectHead);
      })
    ));
    if (freshSnapshots.length !== 1) {
      addViolation(
        violations,
        ['conflicts', index],
        `Active conflict "${conflict.id}" must have exactly one fresh adjudication snapshot`,
      );
    }
  });
  projection.conflictAdjudicationEpisodes.forEach((episode, index) => {
    if (episode.episodeId !== computeConflictEpisodeId(episode)) {
      addViolation(
        violations,
        ['conflictAdjudicationEpisodes', index, 'episodeId'],
        `Conflict episode "${episode.episodeId}" has invalid identity`,
      );
    }
  });
  collectDuplicateIds({
    values: projection.provisionalConflictNormalizationSnapshots,
    registry: 'provisionalConflictNormalizationSnapshots',
    idOf: (snapshot) => snapshot.normalizationSnapshotId,
    violations,
  });
  projection.provisionalConflictNormalizationSnapshots.forEach((snapshot, index) => {
    const subjectIds = new Set<string>();
    for (const subject of snapshot.subjects) {
      if (
        subjectIds.has(subject.subjectId)
        || subject.subjectId !== computeProvisionalConflictNormalizationSubjectId(subject)
      ) {
        addViolation(
          violations,
          ['provisionalConflictNormalizationSnapshots', index, 'subjects'],
          `Normalization subject "${subject.subjectId}" has invalid identity`,
        );
      }
      subjectIds.add(subject.subjectId);
    }
    if (
      snapshot.proofUniverse.proofUniverseDigest
        !== computeProvisionalConflictProofUniverseDigest(snapshot.proofUniverse)
      || snapshot.normalizationSnapshotId
        !== computeProvisionalConflictNormalizationSnapshotId(snapshot)
      || normalizationSnapshotBindingInvalid(projection, snapshot)
    ) {
      addViolation(
        violations,
        ['provisionalConflictNormalizationSnapshots', index],
        `Normalization snapshot "${snapshot.normalizationSnapshotId}" has invalid identity`,
      );
    }
  });
  collectDuplicateIds({
    values: projection.provisionalConflictNormalizations,
    registry: 'provisionalConflictNormalizations',
    idOf: (record) => record.normalizationId,
    violations,
  });
  projection.provisionalConflictNormalizations.forEach((record, index) => {
    const snapshot = projection.provisionalConflictNormalizationSnapshots.find(
      (candidate) => candidate.normalizationSnapshotId === record.normalizationSnapshotId,
    );
    const decisionDigest = computeProvisionalConflictDecisionDigest({
      normalizationSnapshotId: record.normalizationSnapshotId,
      decisions: record.decisions,
      releaseWitnessIds: record.releaseWitnesses.map(({ releaseWitnessId }) => releaseWitnessId),
    });
    const invalidWitness = record.releaseWitnesses.some((witness) => (
      witness.releaseWitnessId !== computeProvisionalConflictReleaseWitnessId(witness)
      || witness.provenAssociationIds.length !== 0
      || witness.normalizationSnapshotId !== record.normalizationSnapshotId
      || witness.proofUniverseDigest !== snapshot?.proofUniverse.proofUniverseDigest
    ));
    const projectionsByFindingId = new Map<string, typeof record.finalFindingProjections>();
    for (const projectionRecord of record.finalFindingProjections) {
      projectionsByFindingId.set(projectionRecord.findingId, [
        ...(projectionsByFindingId.get(projectionRecord.findingId) ?? []),
        projectionRecord,
      ]);
    }
    const subjectFindingIds = new Set(snapshot?.subjects.map((subject) => subject.findingId) ?? []);
    const finalIntents = snapshot === undefined
      ? []
      : record.finalFindingProjections.flatMap((projectionRecord) => {
          const intent = reconstructNormalizationFinalIntent({
            ledgerProjection: projection,
            snapshot,
            decisions: record.decisions,
            projection: projectionRecord,
          });
          return intent === null ? [] : [intent];
        });
    const intentsByFindingId = new Map(finalIntents.map((intent) => [intent.findingId, intent]));
    const decisionsBySubjectId = new Map<string, typeof record.decisions>();
    for (const decision of record.decisions) {
      decisionsBySubjectId.set(decision.subjectId, [
        ...(decisionsBySubjectId.get(decision.subjectId) ?? []),
        decision,
      ]);
    }
    const invalidProjection = snapshot === undefined
      || record.finalFindingProjections.length !== subjectFindingIds.size
      || finalIntents.length !== record.finalFindingProjections.length
      || [...subjectFindingIds].some((findingId) => (
        projectionsByFindingId.get(findingId)?.length !== 1
      ))
      || record.finalFindingProjections.some((projectionRecord) => {
        const intent = intentsByFindingId.get(projectionRecord.findingId);
        return projectionRecord.after.id !== projectionRecord.findingId
          || !sameValue(projectionRecord.expectedHead, intent?.expectedHead)
          || projectionRecord.intentDigest !== intent?.intentDigest
          || (intent !== undefined
            && !normalizationProjectionMatchesIntent(projectionRecord, intent))
          || projectionRecord.projectionDigest
            !== computeFindingLifecycleProjectionDigest(projectionRecord.after);
      });
    const invalidDecision = snapshot === undefined
      || record.decisions.length !== snapshot.subjects.length
      || snapshot.subjects.some((subject) => decisionsBySubjectId.get(subject.subjectId)?.length !== 1)
      || record.decisions.some((decision) => {
        const subject = snapshot.subjects.find((candidate) => candidate.subjectId === decision.subjectId);
        const sourceIntent = intentsByFindingId.get(decision.findingId);
        if (
          subject === undefined
          || subject.findingId !== decision.findingId
          || subject.role !== decision.subjectRole
          || sourceIntent === undefined
        ) {
          return true;
        }
        if (decision.outcome === 'retained_provisional') {
          return sourceIntent.kind !== 'open_provisional'
            || decision.finalIntentDigest !== sourceIntent.intentDigest;
        }
        if (decision.outcome === 'released_independent') {
          const witness = record.releaseWitnesses.find(
            (candidate) => candidate.releaseWitnessId === decision.releaseWitnessId,
          );
          return sourceIntent.kind !== 'open_provisional'
            || sourceIntent.stableKey !== decision.independentStableKey
            || decision.finalIntentDigest !== sourceIntent.intentDigest
            || witness?.holdingSubjectId !== decision.subjectId;
        }
        const association = snapshot.proofUniverse.candidateAssociations.find(
          (candidate) => candidate.associationId === decision.associationId,
        );
        const finalTargetIntent = intentsByFindingId.get(decision.targetFindingId);
        return sourceIntent.kind !== 'superseded'
          || sourceIntent.supersededByFindingId !== decision.targetFindingId
          || association?.sourceHoldingSubjectId !== decision.subjectId
          || association.targetSubjectId !== decision.targetSubjectId
          || !sameSet(decision.proofRecordIds, snapshot.proofUniverse.trustedProofRecordIds.filter(
            (proofRecordId) => projection.evidenceRecords.some((evidence) => (
              evidence.kind === 'engine_proof'
              && evidence.proofId === proofRecordId
              && evidence.subject.kind === 'provisional_conflict_association_identical'
              && evidence.subject.associationId === decision.associationId
            )),
          ))
          || decision.sourceFinalIntentDigest !== sourceIntent.intentDigest
          || decision.targetFinalIntentDigest !== finalTargetIntent?.intentDigest;
      });
    const batchFingerprintDigest = snapshot === undefined
      ? null
      : recomputeNormalizationBatchFingerprint({ projection, snapshot, finalIntents });
    if (
      snapshot === undefined
      || decisionDigest !== record.decisionDigest
      || record.normalizationId !== computeProvisionalConflictNormalizationId({
        normalizationSnapshotId: record.normalizationSnapshotId,
        decisionDigest: record.decisionDigest,
      })
      || invalidWitness
      || invalidProjection
      || invalidDecision
      || record.batchFingerprintDigest !== batchFingerprintDigest
    ) {
      addViolation(
        violations,
        ['provisionalConflictNormalizations', index],
        `Normalization record "${record.normalizationId}" has invalid identity`,
      );
    }
  });
  projection.conflictClaimSettlements.forEach((settlement, index) => {
    if (!('attemptId' in settlement)) {
      const snapshot = projection.provisionalConflictNormalizationSnapshots.find(
        (candidate) => candidate.normalizationSnapshotId === settlement.normalizationSnapshotId,
      );
      const record = projection.provisionalConflictNormalizations.find(
        (candidate) => candidate.normalizationId === settlement.normalizationId,
      );
      const subject = snapshot?.subjects.find(
        (candidate) => candidate.subjectId === settlement.subjectId,
      );
      const events = projection.lifecycleEvents.filter(
        (candidate) => candidate.eventId === settlement.lifecycleEventIds[0],
      );
      const event = events[0];
      const decisions = record?.decisions.filter(
        (decision) => decision.subjectId === settlement.subjectId,
      ) ?? [];
      const decision = decisions[0];
      const finalProjections = record?.finalFindingProjections.filter(
        (candidate) => candidate.findingId === settlement.findingId,
      ) ?? [];
      const finalProjection = finalProjections[0];
      const transitions = event?.transitions.filter((transition) => (
        transition.after.entityKind === 'finding'
        && transition.after.entityId === settlement.findingId
      )) ?? [];
      const transition = transitions[0];
      const reservation = event === undefined
        ? undefined
        : projection.lifecycleReservations.find(
            (candidate) => candidate.reservationId === event.reservationId,
          );
      let outcomeInvalid = decision === undefined || decision.outcome !== settlement.outcome;
      if (!outcomeInvalid && decision?.outcome === 'retained_provisional') {
        outcomeInvalid = settlement.outcome !== 'retained_provisional'
          || finalProjection?.after.status !== 'open'
          || finalProjection.after.provisional === undefined;
      }
      if (!outcomeInvalid && decision?.outcome === 'bundled_into_provisional') {
        outcomeInvalid = settlement.outcome !== 'bundled_into_provisional'
          || settlement.targetFindingId !== decision.targetFindingId
          || !sameSet(settlement.proofRecordIds, decision.proofRecordIds)
          || finalProjection?.after.status !== 'superseded'
          || finalProjection.after.supersededByFindingId !== settlement.targetFindingId
          || finalProjection.after.provisional !== undefined;
      }
      if (!outcomeInvalid && decision?.outcome === 'released_independent') {
        outcomeInvalid = settlement.outcome !== 'released_independent'
          || settlement.releaseWitnessId !== decision.releaseWitnessId
          || settlement.independentStableKey !== decision.independentStableKey
          || finalProjection?.after.status !== 'open'
          || finalProjection.after.provisional?.stableKey !== settlement.independentStableKey;
      }
      if (
        settlement.settlementId !== computeProvisionalConflictNormalizationSettlementId({
          normalizationId: settlement.normalizationId,
          conflictId: settlement.conflictId,
          subjectId: settlement.subjectId,
        })
        || record === undefined
        || record.normalizationSnapshotId !== settlement.normalizationSnapshotId
        || subject === undefined
        || subject.findingId !== settlement.findingId
        || subject.role !== settlement.subjectRole
        || subject.conflictId !== settlement.conflictId
        || !sameValue(subject.expectedHead, settlement.expectedHead)
        || !sameSet(subject.rawClaimLandingIds, settlement.rawClaimLandingIds)
        || decisions.length !== 1
        || finalProjections.length !== 1
        || events.length !== 1
        || event?.operation !== 'normalize_provisional_conflicts'
        || transitions.length !== 1
        || transition?.after.projectionDigest !== finalProjection?.projectionDigest
        || transition?.after.revision !== finalProjection?.after.revision
        || reservation?.authority.kind !== 'provisional_conflict_normalization'
        || reservation.authority.normalizationId !== settlement.normalizationId
        || reservation.authority.normalizationSnapshotId !== settlement.normalizationSnapshotId
        || reservation.authority.decisionDigest !== record.decisionDigest
        || outcomeInvalid
      ) {
        addViolation(
          violations,
          ['conflictClaimSettlements', index, 'settlementId'],
          `Normalization settlement "${settlement.settlementId}" has invalid identity`,
        );
      }
      return;
    }
    const snapshot = projection.conflictAdjudicationSnapshots.find(
      (candidate) => candidate.conflictSnapshotId === settlement.conflictSnapshotId,
    );
    const subject = snapshot?.subjects.find((candidate) => candidate.subjectId === settlement.subjectId);
    const attempt = projection.conflictAdjudicationAttempts.find(
      (candidate) => candidate.attemptId === settlement.attemptId,
    );
    if (settlement.settlementId !== computeConflictClaimSettlementId(
      settlement.conflictId,
      settlement.subjectId,
    ) || subject === undefined
      || subject.role !== settlement.subjectRole
      || subject.findingId !== settlement.findingId
      || !sameValue(subject.expectedHead, settlement.expectedHead)
      || !sameSet(subject.rawClaimLandingIds, settlement.rawClaimLandingIds)
      || attempt?.stage !== 'applied'
      || attempt.verificationDigest !== settlement.verificationDigest
      || !attempt.claimSettlementIds.includes(settlement.settlementId)
      || settlement.lifecycleEventIds.some((eventId) => (
        !projection.lifecycleEvents.some((event) => event.eventId === eventId)
      ))) {
      addViolation(
        violations,
        ['conflictClaimSettlements', index, 'settlementId'],
        `Conflict settlement "${settlement.settlementId}" has invalid identity`,
      );
    }
  });
  projection.conflicts.forEach((conflict, index) => {
    if (conflict.status !== 'resolved') {
      return;
    }
    const settlements = projection.conflictClaimSettlements.filter(
      (settlement) => settlement.conflictId === conflict.id,
    );
    const rawLandingIds = projection.conflictRawClaimLandings
      .filter((landing) => landing.conflictId === conflict.id)
      .map((landing) => landing.rawClaimLandingId);
    const settledRawLandingIds = settlements
      .filter((settlement) => settlement.subjectRole === 'holding_provisional')
      .flatMap((settlement) => settlement.rawClaimLandingIds);
    const substantive = settlements.some((settlement) => (
      settlement.subjectRole === 'holding_provisional'
      || settlement.outcome === 'resolved'
      || settlement.outcome === 'invalidated'
    ));
    const productCovered = conflict.findingIds.every((findingId) => (
      settlements.some((settlement) => (
        settlement.findingId === findingId
        && (
          (settlement.subjectRole === 'product_finding'
            && (settlement.outcome === 'resolved' || settlement.outcome === 'invalidated'))
          || (settlement.subjectRole === 'provisional_target'
            && settlement.outcome === 'retained_provisional')
        )
      ))
      || projection.conflictAdjudicationSnapshots.some((snapshot) => (
        snapshot.conflictId === conflict.id
        && snapshot.subjects.some((subject) => (
          subject.role === 'product_finding'
          && subject.findingId === findingId
          && hasVerifiedOrdinaryLifecycleCoverage({
            lifecycleEvents: projection.lifecycleEvents,
            findingId,
            expectedHead: subject.expectedHead,
          })
        ))
      ))
    ));
    const noUnsettledOpenHolding = sameSet(rawLandingIds, settledRawLandingIds);
    const noLiveAttempt = !projection.conflictAdjudicationAttempts.some((attempt) => (
      attempt.conflictId === conflict.id
      && (attempt.stage === 'started' || attempt.stage === 'proposed')
    ));
    if (
      conflict.findingIds.length + conflict.rawFindingIds.length === 0
      || !substantive
      || !sameSet(rawLandingIds, settledRawLandingIds)
      || settledRawLandingIds.length !== new Set(settledRawLandingIds).size
      || !productCovered
      || !noUnsettledOpenHolding
      || !noLiveAttempt
    ) {
      addViolation(
        violations,
        ['conflicts', index, 'status'],
        `Resolved conflict "${conflict.id}" does not have durable substantive settlement coverage`,
      );
    }
  });
  projection.terminalAdjudicationRounds.forEach((round, index) => {
    if (round.selectionId !== computeTerminalSelectionId(round.roundIdentity, round.members)) {
      addViolation(
        violations,
        ['terminalAdjudicationRounds', index, 'selectionId'],
        `Terminal selection "${round.selectionId}" has invalid identity`,
      );
    }
    const duplicateRound = projection.terminalAdjudicationRounds.findIndex(
      (candidate) => candidate.roundIdentity === round.roundIdentity,
    );
    if (duplicateRound !== index) {
      addViolation(violations, ['terminalAdjudicationRounds', index], `Terminal round "${round.roundIdentity}" is not exact-one`);
    }
    for (const member of round.members) {
      const episode = projection.terminalAdjudicationEpisodes.find(
        (candidate) => candidate.episodeId === member.episodeId,
      );
      if (episode === undefined
        || episode.selectionId !== round.selectionId
        || episode.roundIdentity !== round.roundIdentity
        || episode.findingId !== member.findingId
        || episode.candidateSnapshotDigest !== member.candidateSnapshotDigest) {
        addViolation(violations, ['terminalAdjudicationRounds', index, 'members'], `Terminal selection member "${member.episodeId}" does not match its episode`);
      }
    }
  });
  projection.terminalAdjudicationEpisodes.forEach((episode, index) => {
    if (episode.episodeId !== computeTerminalEpisodeId(episode)) {
      addViolation(
        violations,
        ['terminalAdjudicationEpisodes', index, 'episodeId'],
        `Terminal episode "${episode.episodeId}" has invalid identity`,
      );
    }
    const matchingRounds = projection.terminalAdjudicationRounds.filter((round) => (
      round.selectionId === episode.selectionId
      && round.roundIdentity === episode.roundIdentity
      && round.members.some((member) => member.episodeId === episode.episodeId)
    ));
    const attempts = projection.terminalAdjudicationAttempts.filter(
      (attempt) => attempt.episodeId === episode.episodeId,
    ).sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    const attemptSequenceValid = attempts.length <= episode.maxAttempts
      && attempts.every((attempt, attemptIndex) => (
        attempt.attemptOrdinal === attemptIndex + 1
        && attempt.retryOrdinal === attemptIndex
        && attempt.selectionId === episode.selectionId
        && attempt.roundIdentity === episode.roundIdentity
        && attempt.findingId === episode.findingId
        && sameValue(attempt.expectedHead, episode.expectedHead)
        && attempt.candidateSnapshotDigest === episode.candidateSnapshotDigest
        && (attemptIndex === 0 || attempts[attemptIndex - 1]?.stage === 'interrupted')
      ))
      && attempts.slice(0, -1).every((attempt) => attempt.stage === 'interrupted');
    if (matchingRounds.length !== 1 || !attemptSequenceValid) {
      addViolation(violations, ['terminalAdjudicationEpisodes', index], `Terminal episode "${episode.episodeId}" has invalid round or attempt continuity`);
    }
  });
  projection.terminalAdjudicationSettlements.forEach((settlement, index) => {
    if (settlement.settlementId !== computeTerminalSettlementId(settlement.episodeId)) {
      addViolation(
        violations,
        ['terminalAdjudicationSettlements', index, 'settlementId'],
        `Terminal settlement "${settlement.settlementId}" has invalid identity`,
      );
    }
    const episode = projection.terminalAdjudicationEpisodes.find(
      (candidate) => candidate.episodeId === settlement.episodeId,
    );
    if (settlement.outcome === 'reclassified_to_reviewer_anomaly') {
      const finding = projection.findings.find(
        (candidate) => candidate.id === settlement.provisionalFindingId,
      );
      const attempts = projection.terminalAdjudicationAttempts.filter(
        (attempt) => settlement.attemptIds.includes(attempt.attemptId),
      );
      if (
        episode === undefined
        || finding?.reviewerAnomalyReclassification?.migrationId !== settlement.migrationId
        || finding.reviewerAnomalyReclassification?.anomalyId === undefined
        || !sameValue(attempts.map(({ attemptId }) => attemptId).sort(compareBinaryStrings), settlement.attemptIds)
        || attempts.some((attempt) => attempt.episodeId !== settlement.episodeId)
      ) {
        addViolation(
          violations,
          ['terminalAdjudicationSettlements', index],
          `Terminal reclassification settlement "${settlement.settlementId}" is invalid`,
        );
      }
      return;
    }
    if (settlement.outcome === 'superseded' || settlement.outcome === 'exhausted') {
      const attempts = projection.terminalAdjudicationAttempts.filter(
        (attempt) => attempt.episodeId === settlement.episodeId,
      ).sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
      const latestAttempt = attempts.at(-1);
      const supersedingEpisode = settlement.supersedingEpisodeId === null
        ? undefined
        : projection.terminalAdjudicationEpisodes.find(
            (candidate) => candidate.episodeId === settlement.supersedingEpisodeId,
          );
      const changedCandidateMatches = supersedingEpisode !== undefined
          && supersedingEpisode.findingId === episode?.findingId
          && supersedingEpisode.candidateSnapshotDigest
            === settlement.supersedingCandidateSnapshotDigest
          && supersedingEpisode.candidateSnapshotDigest !== settlement.candidateSnapshotDigest;
      const absentCandidateMatches = settlement.supersedingEpisodeId === null
        && settlement.supersedingCandidateSnapshotDigest === null;
      const supersessionMatches = settlement.outcome === 'superseded'
        ? settlement.reason === 'candidate_snapshot_changed'
          ? changedCandidateMatches
          : absentCandidateMatches
        : settlement.reason === 'attempts_exhausted_interrupted'
          ? absentCandidateMatches
          : changedCandidateMatches || absentCandidateMatches;
      const attemptStateMatches = settlement.outcome === 'superseded'
        ? attempts.length === 0
        : settlement.reason === 'attempts_exhausted_interrupted'
          ? attempts.length === (episode?.maxAttempts ?? -1)
            && latestAttempt?.stage === 'interrupted'
            && settlement.attemptId === latestAttempt.attemptId
          : attempts.length > 0
            && latestAttempt?.stage === 'completed'
            && latestAttempt.result.kind === 'stale_precondition'
            && latestAttempt.result.proposal === null
            && latestAttempt.result.proposalDigest === null
            && settlement.attemptId === latestAttempt.attemptId;
      if (
        episode === undefined
        || settlement.provisionalFindingId !== episode.findingId
        || !sameValue(settlement.expectedHead, episode.expectedHead)
        || settlement.candidateSnapshotDigest !== episode.candidateSnapshotDigest
        || !attemptStateMatches
        || !supersessionMatches
      ) {
        addViolation(
          violations,
          ['terminalAdjudicationSettlements', index],
          `Terminal episode closure "${settlement.settlementId}" is invalid`,
        );
      }
      return;
    }
    const attempt = projection.terminalAdjudicationAttempts.find(
      (candidate) => candidate.attemptId === settlement.attemptId,
    );
    const finding = projection.findings.find(
      (candidate) => candidate.id === settlement.provisionalFindingId,
    );
    const events = settlement.lifecycleEventIds.map((eventId) => (
      projection.lifecycleEvents.find((event) => event.eventId === eventId)
    ));
    const projectionMatches = finding !== undefined && (
      (settlement.outcome === 'promoted' && finding.provisional === undefined)
      || (settlement.outcome === 'merged'
        && finding.status === 'superseded'
        && finding.supersededByFindingId === settlement.targetFindingId)
      || (settlement.outcome === 'dismissed' && finding.status === 'dismissed')
    );
    if (
      attempt?.stage !== 'applied'
      || episode === undefined
      || attempt.episodeId !== settlement.episodeId
      || attempt.settlementId !== settlement.settlementId
      || attempt.verificationDigest !== settlement.verificationDigest
      || settlement.provisionalFindingId !== episode.findingId
      || !sameValue(settlement.expectedHead, episode.expectedHead)
      || !sameSet(settlement.sourceClaimRefIds, attempt.sourceClaimRefIds)
      || !sameSet(settlement.lifecycleEventIds, attempt.lifecycleEventIds)
      || events.some((event) => event === undefined)
      || !events.some((event) => event?.transitions.some((transition) => (
        transition.before !== null
        && sameValue(transition.before, episode.expectedHead)
      )))
      || !projectionMatches
    ) {
      addViolation(violations, ['terminalAdjudicationSettlements', index], `Terminal settlement "${settlement.settlementId}" is not linked to an applied attempt and lifecycle projection`);
    }
  });
  projection.terminalAdjudicationAttempts.forEach((attempt, index) => {
    const exhaustedSettlements = projection.terminalAdjudicationSettlements.filter(
      (settlement) => settlement.outcome === 'exhausted'
        && settlement.attemptId === attempt.attemptId,
    );
    const requiresExhaustedSettlement = attempt.stage === 'completed'
      && attempt.result.kind === 'stale_precondition'
      && attempt.result.proposal === null
      && attempt.result.proposalDigest === null;
    const episode = projection.terminalAdjudicationEpisodes.find(
      (candidate) => candidate.episodeId === attempt.episodeId,
    );
    const episodeAttempts = projection.terminalAdjudicationAttempts
      .filter((candidate) => candidate.episodeId === attempt.episodeId)
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    const requiresRetryExhaustedSettlement = episode !== undefined
      && attempt.stage === 'interrupted'
      && episodeAttempts.length === episode.maxAttempts
      && episodeAttempts.at(-1)?.attemptId === attempt.attemptId;
    if (
      ((requiresExhaustedSettlement || requiresRetryExhaustedSettlement)
        && exhaustedSettlements.length !== 1)
      || (!(requiresExhaustedSettlement || requiresRetryExhaustedSettlement)
        && exhaustedSettlements.length !== 0)
    ) {
      addViolation(
        violations,
        ['terminalAdjudicationAttempts', index],
        `Terminal attempt "${attempt.attemptId}" has invalid exhausted settlement ownership`,
      );
    }
    const settlements = projection.terminalAdjudicationSettlements.filter(
      (settlement) => settlement.outcome !== 'superseded'
        && settlement.outcome !== 'exhausted'
        && settlement.outcome !== 'reclassified_to_reviewer_anomaly'
        && settlement.attemptId === attempt.attemptId,
    );
    if ((attempt.stage === 'applied' && settlements.length !== 1)
      || (attempt.stage !== 'applied' && settlements.length !== 0)) {
      addViolation(violations, ['terminalAdjudicationAttempts', index], `Terminal attempt "${attempt.attemptId}" has invalid settlement ownership`);
    }
  });
  projection.terminalAdjudicationEpisodes.forEach((episode, index) => {
    const settlements = projection.terminalAdjudicationSettlements.filter(
      (settlement) => settlement.episodeId === episode.episodeId,
    );
    if (settlements.length > 1) {
      addViolation(violations, ['terminalAdjudicationEpisodes', index], `Terminal episode "${episode.episodeId}" has multiple settlements`);
    }
  });
  projection.findingScopeBindings.forEach((binding, index) => {
    const dependencyViolation = findingScopeBindingDependencyViolation(binding);
    if (binding.bindingId !== computeFindingScopeBindingId(binding) || dependencyViolation !== undefined) {
      addViolation(
        violations,
        ['findingScopeBindings', index, 'bindingId'],
        dependencyViolation
          ?? `Finding scope binding "${binding.bindingId}" has invalid identity`,
      );
    }
  });
}

function collectReviewerAnomalyViolations(
  projection: FindingLedgerProjectionInvariantInput,
  rawById: ReadonlyMap<string, RawFinding>,
  violations: Violation[],
): void {
  const anomalyIds = new Set<string>();
  const anomalyIdentityByStableKey = new Map<string, string>();
  const outstandingStableKeys = new Set<string>();
  for (const [index, anomaly] of (projection.reviewerAnomalies ?? []).entries()) {
    if (anomalyIds.has(anomaly.id)) {
      addViolation(
        violations,
        ['reviewerAnomalies', index, 'id'],
        `Duplicate reviewer anomaly id "${anomaly.id}"`,
      );
    }
    anomalyIds.add(anomaly.id);
    const stableIdentity = canonicalJson({
      kind: anomaly.kind,
      ...(anomaly.kind === 'intake-contract-incomplete' ? {} : { lineageKey: anomaly.lineageKey }),
    });
    const priorStableIdentity = anomalyIdentityByStableKey.get(anomaly.stableKey);
    if (priorStableIdentity !== undefined && priorStableIdentity !== stableIdentity) {
      addViolation(
        violations,
        ['reviewerAnomalies', index, 'stableKey'],
        `Reviewer anomaly stable key "${anomaly.stableKey}" identifies different anomaly content`,
      );
    }
    anomalyIdentityByStableKey.set(anomaly.stableKey, stableIdentity);
    if (anomaly.promotedFindingId === undefined && anomaly.settlement === undefined) {
      if (outstandingStableKeys.has(anomaly.stableKey)) {
        addViolation(
          violations,
          ['reviewerAnomalies', index, 'stableKey'],
          `Reviewer anomaly stable key "${anomaly.stableKey}" has multiple outstanding episodes`,
        );
      }
      outstandingStableKeys.add(anomaly.stableKey);
    }
    anomaly.sourceRawFindingIds.forEach((rawFindingId, rawIndex) => {
      if (!rawById.has(rawFindingId)) {
        addViolation(
          violations,
          ['reviewerAnomalies', index, 'sourceRawFindingIds', rawIndex],
          `Reviewer anomaly "${anomaly.id}" references unknown raw finding "${rawFindingId}"`,
        );
      }
    });
    if (anomaly.kind === 'intake-contract-incomplete') {
      const defect = anomaly.intakeContract;
      if (defect === undefined) {
        addViolation(
          violations,
          ['reviewerAnomalies', index, 'intakeContract'],
          'intake-contract-incomplete requires intakeContract',
        );
      } else {
        if (
          defect.classificationAuthorityId !== 'system/intake_observation_classification_v1'
          || defect.presentationOwnerReviewer.length === 0
          || !Number.isSafeInteger(defect.presentationLimit)
          || defect.presentationLimit < 1
          || defect.reasonCodes.length === 0
          || !defect.reasonCodes.every((code) => (
            (INTAKE_CONTRACT_ANOMALY_REASON_CODES as readonly string[]).includes(code)
          ))
          || !defect.missingRequirements.every((requirement) => (
            (INTAKE_CONTRACT_MISSING_REQUIREMENTS as readonly string[]).includes(requirement)
          ))
          || JSON.stringify(defect.reasonCodes)
            !== JSON.stringify([...new Set(defect.reasonCodes)].sort(compareBinaryStrings))
          || JSON.stringify(defect.missingRequirements)
            !== JSON.stringify([...new Set(defect.missingRequirements)].sort(compareBinaryStrings))
        ) {
          addViolation(
            violations,
            ['reviewerAnomalies', index, 'intakeContract'],
            `Intake contract metadata for anomaly "${anomaly.id}" is invalid`,
          );
        }
        if (
          defect.terminalDisposition !== undefined
          && (
            anomaly.promotedFindingId !== undefined
            || anomaly.settlement !== undefined
            || (defect.observationClass === 'claim-bearing'
              && (
                defect.terminalDisposition.workflowOutcome !== 'review_integrity_unresolved'
                || defect.terminalDisposition.kind !== 'restatement_exhausted_claim_bearing'
              ))
            || (defect.observationClass === 'protocol-noise'
              && (
                defect.terminalDisposition.workflowOutcome !== 'non_claim_observation_rejected'
                || defect.terminalDisposition.kind !== 'protocol_noise_rejected_after_presentation'
              ))
          )
        ) {
          addViolation(
            violations,
            ['reviewerAnomalies', index, 'intakeContract', 'terminalDisposition'],
            `Intake contract terminal disposition for anomaly "${anomaly.id}" conflicts with its classification or settlement`,
          );
        }
      }
    } else if (anomaly.intakeContract !== undefined) {
      addViolation(
        violations,
        ['reviewerAnomalies', index, 'intakeContract'],
        `Anomaly kind "${anomaly.kind}" must not contain intakeContract`,
      );
    }
    if (anomaly.settlement !== undefined) {
      const settlementViolation = reviewerAnomalySettlementEligibilityViolation({
        projection,
        anomaly,
        settlement: anomaly.settlement,
        sourceHead: { kind: 'projection' },
        workflowTaskDigest: null,
      });
      if (settlementViolation !== undefined) {
        addViolation(
          violations,
          ['reviewerAnomalies', index, 'settlement'],
          anomaly.settlement.kind === 'target_resolved_by_verified_evidence'
            ? `Reviewer anomaly "${anomaly.id}" has an invalid verified-resolution settlement: ${settlementViolation}`
            : `Reviewer anomaly "${anomaly.id}" has an invalid terminal-dismissal settlement: ${settlementViolation}`,
        );
      }
    }
  }
}

export function collectFindingLedgerProjectionInvariantViolations(
  projection: FindingLedgerProjectionInvariantInput,
): FindingLedgerProjectionInvariantViolation[] {
  const violations: Violation[] = [];
  const core = collectCoreViolations(projection, violations);
  collectReclassificationViolations(
    projection,
    core.rawById,
    violations,
  );
  const rawSnapshots = collectRawSnapshotViolations(projection, core.rawById, violations);
  const caseSnapshotIds = collectInterpretationViolations(
    projection,
    core.rawById,
    rawSnapshots,
    violations,
  );
  collectProviderAndAttemptViolations(projection, caseSnapshotIds, violations);
  collectOutcomeViolations(projection, violations);
  collectConflictAndTerminalIdentityViolations(projection, violations);
  collectReviewerAnomalyViolations(projection, core.rawById, violations);
  return violations;
}

export function assertFindingLedgerProjectionInvariant(
  projection: FindingLedgerProjectionInvariantInput,
): void {
  const violation = collectFindingLedgerProjectionInvariantViolations(projection)[0];
  if (violation !== undefined) {
    throw new Error(violation.message);
  }
}
