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
  computeTerminalAttemptId,
  computeTerminalEpisodeId,
  computeTerminalSelectionId,
  computeTerminalSettlementId,
} from './finding-contract-identity.js';
import { findingScopeBindingDependencyViolation } from './finding-scope-binding-dependencies.js';
import { hasVerifiedOrdinaryLifecycleCoverage } from './finding-lifecycle-continuity.js';
import type {
  FindingContractLedgerRegistries,
} from './finding-contract-types.js';
import { formatConflictId, type ConflictIdentity } from './finding-conflict-identity.js';
import { computeInterpretationAttemptId } from './finding-interpretation-identity.js';
import {
  isConcludedReviewerAnomaly,
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
  ReviewerAnomalySettlement,
} from './finding-types.js';

const FINDING_ID_PATTERN = /^F-(\d{4})$/;

type ReadonlyContractRegistries = {
  readonly [Key in keyof FindingContractLedgerRegistries]: Readonly<
    FindingContractLedgerRegistries[Key]
  >;
};

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
  projection.conflictClaimSettlements.forEach((settlement, index) => {
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
          settlement.subjectRole === 'product_finding'
            && (settlement.outcome === 'resolved' || settlement.outcome === 'invalidated')
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

/** 違反メッセージ用の決着種別ラベル。default 節が kind 追加時の網羅性を型で守る。 */
function reviewerAnomalySettlementLabel(settlement: ReviewerAnomalySettlement): string {
  switch (settlement.kind) {
    case 'target_resolved_by_verified_evidence':
      return 'verified-resolution';
    case 'target_dismissed_by_terminal_adjudication':
      return 'terminal-dismissal';
    case 'withdrawn_by_subsequent_review':
      return 'subsequent-review withdrawal';
    default: {
      const unexpected: never = settlement;
      throw new Error(`Unsupported reviewer anomaly settlement: ${JSON.stringify(unexpected)}`);
    }
  }
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
    // 終端処分も決着なので live episode ではない。決着済みを live として数えると、
    // 同じ観測が終端後に再び現れたときに新しい episode を起こせなくなり、観測を
    // 捨てるか決着済み episode を書き換えるかの二択になる。判定は書き込み側
    // （applyReviewerAnomalySpecsToLedger の upsert 対象選定）と同じ述語を使う。
    if (!isConcludedReviewerAnomaly(anomaly)) {
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
        // 言い直しで要求できる claim 本文が無い観測の終端は、observationClass 由来の
        // 対応表の外にある（提示を1回も行わずに決着する唯一の kind）。
        const undemandableTerminal = defect.terminalDisposition?.kind === 'undemandable_claim_atom';
        if (
          defect.terminalDisposition !== undefined
          && (
            anomaly.promotedFindingId !== undefined
            || anomaly.settlement !== undefined
            || (undemandableTerminal
              && defect.terminalDisposition.workflowOutcome !== (
                defect.observationClass === 'claim-bearing'
                  ? 'review_integrity_unresolved'
                  : 'non_claim_observation_rejected'
              ))
            || (!undemandableTerminal && defect.observationClass === 'claim-bearing'
              && (
                defect.terminalDisposition.workflowOutcome !== 'review_integrity_unresolved'
                || defect.terminalDisposition.kind !== 'restatement_exhausted_claim_bearing'
              ))
            || (!undemandableTerminal && defect.observationClass === 'protocol-noise'
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
          `Reviewer anomaly "${anomaly.id}" has an invalid ${reviewerAnomalySettlementLabel(anomaly.settlement)} settlement: ${settlementViolation}`,
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
