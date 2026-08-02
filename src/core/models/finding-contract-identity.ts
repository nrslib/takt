import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  ConflictAdjudicationSnapshot,
  ConflictClaimSubject,
  ConflictRawClaimLanding,
  FindingManagerAttemptKind,
  FindingScopeBinding,
  InterpretationCaseSnapshot,
  InterpretationRawObservation,
  InterpretationRecoveryOriginBinding,
  RawCanonicalSnapshot,
  TerminalAdjudicationSelectionMember,
} from './finding-contract-types.js';
import type {
  FindingLifecycleEntityHead,
  FindingProvisionalKind,
  RawFinding,
} from './finding-types.js';

type ContentAddressPayload = Readonly<object>;

function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(`Content address payload contains undefined at "${path}"`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoUndefined(item, `${path}.${key}`);
    }
  }
}

export function findingContentAddress(
  domain: string,
  payload: ContentAddressPayload,
): string {
  if (domain.length === 0) {
    throw new Error('Content address domain must not be empty');
  }
  assertNoUndefined(payload, 'payload');
  if (Object.hasOwn(payload, 'domain')) {
    throw new Error('Content address payload must not contain the reserved "domain" key');
  }
  return createHash('sha256')
    .update(canonicalJson({ domain, ...payload }))
    .digest('hex');
}

export function binarySortedUnique(values: readonly string[]): string[] {
  const sorted = [...values].sort(compareBinaryStrings);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new Error(`Content address set contains duplicate value "${sorted[index]}"`);
    }
  }
  return sorted;
}

function binarySortedObjects<Value extends object>(
  values: readonly Value[],
): Value[] {
  const keyed = values.map((value) => ({ key: canonicalJson(value), value }));
  keyed.sort((left, right) => compareBinaryStrings(left.key, right.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index]?.key === keyed[index - 1]?.key) {
      throw new Error('Content address set contains a duplicate object');
    }
  }
  return keyed.map(({ value }) => value);
}

export function computeRawPayloadDigest(rawFinding: RawFinding): string {
  return findingContentAddress('raw-finding-payload', { rawFinding });
}

export function computeRawCanonicalSnapshotId(
  snapshot: Omit<RawCanonicalSnapshot, 'rawCanonicalSnapshotId' | 'capturedAt'>,
): string {
  return findingContentAddress('raw-canonical-snapshot', {
    rawFindingId: snapshot.rawFindingId,
    rawPayloadDigest: snapshot.rawPayloadDigest,
    reviewerStableKey: snapshot.reviewerStableKey,
    lineageKey: snapshot.lineageKey,
    targetIdentityHash: snapshot.targetIdentityHash,
    claimIdentityHash: snapshot.claimIdentityHash,
    semanticClaimIdentityHash: snapshot.semanticClaimIdentityHash,
    canonicalProvenance: snapshot.canonicalProvenance,
    canonicalizationContextDigest: snapshot.canonicalizationContextDigest,
    captureAdmissionSnapshotId: snapshot.captureAdmissionSnapshotId,
    captureDependencyDigests: binarySortedUnique(snapshot.captureDependencyDigests),
    canonicalIntegrityDigest: snapshot.canonicalIntegrityDigest,
  });
}

export function computeInterpretationObservationDigest(
  observation: Pick<
    InterpretationRawObservation,
    | 'rawFindingId'
    | 'rawCanonicalSnapshotId'
    | 'semanticProjectionDigest'
    | 'originSnapshotDigests'
  >,
): string {
  return findingContentAddress('interpretation-member-observation', {
    rawFindingId: observation.rawFindingId,
    rawCanonicalSnapshotId: observation.rawCanonicalSnapshotId,
    semanticProjectionDigest: observation.semanticProjectionDigest,
    originSnapshotDigests: binarySortedUnique(observation.originSnapshotDigests),
  });
}

export function computeInterpretationOriginSnapshotDigest(input: {
  originFindingId: string;
  expectedHead: FindingLifecycleEntityHead;
  originProvisionalKind: FindingProvisionalKind;
  originStableKey: string;
  originLineageKey: string;
  recoveryReviewerStableKey: string;
  sourceRawFindingIdsDigest: string;
}): string {
  return findingContentAddress('interpretation-recovery-origin-snapshot', input);
}

export function computeInterpretationOriginSnapshotSetDigest(
  observations: readonly Pick<
    InterpretationRawObservation,
    'rawFindingId' | 'originSnapshotDigests'
  >[],
): string {
  const members = binarySortedObjects(observations.map((observation) => ({
    rawFindingId: observation.rawFindingId,
    originSnapshotDigests: binarySortedUnique(observation.originSnapshotDigests),
  })));
  return findingContentAddress('interpretation-recovery-origin-snapshot-set', { members });
}

export function computeInterpretationCaseSnapshotId(
  snapshot: Omit<InterpretationCaseSnapshot, 'caseSnapshotId' | 'createdAt'>,
): string {
  return findingContentAddress('interpretation-case-snapshot', {
    caseId: snapshot.caseId,
    cohortId: snapshot.cohortId,
    roundIdentity: snapshot.roundIdentity,
    lineageKey: snapshot.lineageKey,
    policyClass: snapshot.policyClass,
    semanticProjectionDigest: snapshot.semanticProjectionDigest,
    memberRawFindingIds: binarySortedUnique(snapshot.memberRawFindingIds),
    memberObservationDigests: snapshot.memberObservationDigests,
    originSnapshotSetDigest: snapshot.originSnapshotSetDigest,
  });
}

export function computeInterpretationOriginBindingId(
  binding: Pick<
    InterpretationRecoveryOriginBinding,
    'caseSnapshotId' | 'observationRawFindingId' | 'originFindingId' | 'originSnapshotDigest'
  >,
): string {
  return findingContentAddress('interpretation-recovery-origin-binding', {
    caseSnapshotId: binding.caseSnapshotId,
    observationRawFindingId: binding.observationRawFindingId,
    originFindingId: binding.originFindingId,
    originSnapshotDigest: binding.originSnapshotDigest,
  });
}

export function computeInterpretationOriginSettlementId(bindingId: string): string {
  return findingContentAddress('interpretation-recovery-origin-settlement', { bindingId });
}

export function computeFindingManagerRoundIdentity(input: {
  scopeIdentity: string;
  workflowName: string;
  roundMarker: string;
}): string {
  return findingContentAddress('finding-manager-logical-round', {
    scopeIdentity: input.scopeIdentity,
    workflowName: input.workflowName,
    roundMarker: input.roundMarker,
  });
}

export function computeFindingManagerBudgetScopeId(roundIdentity: string): string {
  return findingContentAddress('finding-manager-provider-budget-scope', { roundIdentity });
}

export function computeFindingManagerRequestDigest(requestBytes: string): string {
  return findingContentAddress('finding-manager-provider-request', { requestBytes });
}

export function computeFindingManagerProviderCallId(input: {
  budgetScopeId: string;
  callOrdinal: number;
  purpose: FindingManagerAttemptKind;
  attemptIds: readonly string[];
  requestDigest: string;
}): string {
  return findingContentAddress('finding-manager-provider-call', {
    budgetScopeId: input.budgetScopeId,
    callOrdinal: input.callOrdinal,
    purpose: input.purpose,
    attemptIds: binarySortedUnique(input.attemptIds),
    requestDigest: input.requestDigest,
  });
}

export function computeFindingScopeBindingId(
  binding: Omit<FindingScopeBinding, 'bindingId' | 'issuedAt'>,
): string {
  return findingContentAddress('finding-scope-binding', {
    source: binding.source,
    findingId: binding.findingId,
    expectedHead: binding.expectedHead,
    workflowTaskDigest: binding.workflowTaskDigest,
    findingContractDigest: binding.findingContractDigest,
    predicate: binding.predicate,
    result: binding.result,
    verifierId: binding.verifierId,
    verifierVersion: binding.verifierVersion,
    dependencyDigests: binarySortedUnique(binding.dependencyDigests),
  });
}

export function computeConflictRawClaimLandingId(
  landing: Pick<
    ConflictRawClaimLanding,
    | 'conflictId'
    | 'rawFindingId'
    | 'rawCanonicalSnapshotId'
    | 'rawPayloadDigest'
    | 'claimSnapshotDigest'
  >,
): string {
  return findingContentAddress('conflict-raw-claim-landing', {
    conflictId: landing.conflictId,
    rawFindingId: landing.rawFindingId,
    rawCanonicalSnapshotId: landing.rawCanonicalSnapshotId,
    rawPayloadDigest: landing.rawPayloadDigest,
    claimSnapshotDigest: landing.claimSnapshotDigest,
  });
}

export function computeConflictRawClaimSnapshotDigest(
  snapshot: Pick<
    RawCanonicalSnapshot,
    'targetIdentityHash' | 'claimIdentityHash' | 'semanticClaimIdentityHash'
  >,
): string {
  return findingContentAddress('conflict-raw-claim-snapshot', {
    targetIdentityHash: snapshot.targetIdentityHash,
    claimIdentityHash: snapshot.claimIdentityHash,
    semanticClaimIdentityHash: snapshot.semanticClaimIdentityHash,
  });
}

export function computeConflictHoldingAllocationId(
  conflictId: string,
  rawClaimLandingIds: readonly string[],
): string {
  return findingContentAddress('conflict-holding-allocation', {
    conflictId,
    rawClaimLandingIds: binarySortedUnique(rawClaimLandingIds),
  });
}

export function computeConflictHoldingStableKey(input: {
  conflictId: string;
  holdingAllocationId: string;
  provisionalKind: FindingProvisionalKind;
}): string {
  return findingContentAddress('conflict-holding-stable-key', input);
}

export function computeTerminalSelectionId(
  roundIdentity: string,
  members: readonly TerminalAdjudicationSelectionMember[],
): string {
  return findingContentAddress('terminal-adjudication-selection', {
    roundIdentity,
    members: binarySortedObjects(members),
  });
}

export function computeTerminalEpisodeId(input: {
  findingId: string;
  expectedHead: FindingLifecycleEntityHead;
  candidateSnapshotDigest: string;
}): string {
  return findingContentAddress('terminal-adjudication-episode', {
    findingId: input.findingId,
    expectedHead: input.expectedHead,
    candidateSnapshotDigest: input.candidateSnapshotDigest,
  });
}

export function computeTerminalAttemptId(input: {
  episodeId: string;
  attemptOrdinal: 1 | 2;
  retryOrdinal: 0 | 1;
}): string {
  return findingContentAddress('terminal-adjudication-attempt', {
    episodeId: input.episodeId,
    attemptOrdinal: input.attemptOrdinal,
    retryOrdinal: input.retryOrdinal,
  });
}

export function computeTerminalSettlementId(episodeId: string): string {
  return findingContentAddress('terminal-adjudication-settlement', { episodeId });
}

export function computeConflictClaimSubjectId(
  subject: Omit<ConflictClaimSubject, 'subjectId'>,
): string {
  return findingContentAddress('conflict-claim-subject', {
    conflictId: subject.conflictId,
    role: subject.role,
    findingId: subject.findingId,
    expectedHead: subject.expectedHead,
    targetIdentityHash: subject.targetIdentityHash,
    claimIdentityHash: subject.claimIdentityHash,
    semanticClaimIdentityHash: subject.semanticClaimIdentityHash,
    claimSnapshotDigest: subject.claimSnapshotDigest,
    sourceRawFindingIds: binarySortedUnique(subject.sourceRawFindingIds),
    sourceRawPayloadDigests: binarySortedUnique(subject.sourceRawPayloadDigests),
    rawClaimLandingIds: binarySortedUnique(subject.rawClaimLandingIds),
    evidenceBindingIds: binarySortedUnique(subject.evidenceBindingIds),
    evidenceSetDigest: subject.evidenceSetDigest,
  });
}

export function computeConflictClaimUniverseDigest(input: {
  conflictId: string;
  productFindingIds: readonly string[];
  rawClaimLandingIds: readonly string[];
}): string {
  return findingContentAddress('conflict-claim-universe', {
    conflictId: input.conflictId,
    productFindingIds: binarySortedUnique(input.productFindingIds),
    rawClaimLandingIds: binarySortedUnique(input.rawClaimLandingIds),
  });
}

export function computeConflictCoverageSnapshotDigest(input: {
  claimUniverseDigest: string;
  subjectIds: readonly string[];
  priorSettlementIds: readonly string[];
}): string {
  return findingContentAddress('conflict-claim-coverage-snapshot', {
    claimUniverseDigest: input.claimUniverseDigest,
    subjectIds: binarySortedUnique(input.subjectIds),
    priorSettlementIds: binarySortedUnique(input.priorSettlementIds),
  });
}

export function computeConflictSnapshotId(
  snapshot: Omit<ConflictAdjudicationSnapshot, 'conflictSnapshotId' | 'createdAt'>,
): string {
  return findingContentAddress('conflict-adjudication-snapshot', {
    conflictId: snapshot.conflictId,
    expectedConflictHead: snapshot.expectedConflictHead,
    claimUniverseDigest: snapshot.claimUniverseDigest,
    coverageSnapshotDigest: snapshot.coverageSnapshotDigest,
    evidenceSnapshotDigest: snapshot.evidenceSnapshotDigest,
    subjects: binarySortedUnique(snapshot.subjects.map(({ subjectId }) => subjectId)),
    originStep: snapshot.originStep,
  });
}

export function computeConflictEpisodeId(input: {
  conflictId: string;
  expectedConflictHead: FindingLifecycleEntityHead;
  conflictSnapshotId: string;
}): string {
  return findingContentAddress('conflict-adjudication-episode', {
    conflictId: input.conflictId,
    expectedConflictHead: input.expectedConflictHead,
    conflictSnapshotId: input.conflictSnapshotId,
  });
}

export function computeConflictAttemptId(input: {
  episodeId: string;
  attemptOrdinal: 1 | 2;
  retryOrdinal: 0 | 1;
}): string {
  return findingContentAddress('conflict-adjudication-attempt', {
    episodeId: input.episodeId,
    attemptOrdinal: input.attemptOrdinal,
    retryOrdinal: input.retryOrdinal,
  });
}

export function computeConflictClaimSettlementId(
  conflictId: string,
  subjectId: string,
): string {
  return findingContentAddress('conflict-claim-settlement', { conflictId, subjectId });
}
