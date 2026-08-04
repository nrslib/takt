import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  binarySortedUnique,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  ConflictAdjudicationProposal,
  ConflictAdjudicationSnapshot,
  ConflictClaimSubject,
  ConflictVerificationFailureCode,
  ResolvedConflictAdjudicationPlan,
  VerifiedConflictAdjudicationAuthority,
} from '../../models/finding-contract-types.js';
import type { EngineProofRecord, FindingLedger } from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../../models/finding-claim-identity.js';

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = binarySortedUnique(left);
  const b = binarySortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function referencedProofs(
  ledger: FindingLedger,
  authorityRefIds: readonly string[],
): EngineProofRecord[] | undefined {
  const records: EngineProofRecord[] = [];
  for (const referenceId of authorityRefIds) {
    const matches = ledger.evidenceRecords.filter((record): record is EngineProofRecord => (
      record.kind === 'engine_proof'
      && (record.evidenceId === referenceId || record.proofId === referenceId)
    ));
    if (matches.length !== 1) {
      return undefined;
    }
    records.push(matches[0]!);
  }
  return [...new Map(records.map((record) => [record.evidenceId, record])).values()]
    .sort((left, right) => compareBinaryStrings(left.evidenceId, right.evidenceId));
}

function subject(
  snapshot: ConflictAdjudicationSnapshot,
  subjectId: string,
): ConflictClaimSubject | undefined {
  return snapshot.subjects.find((candidate) => candidate.subjectId === subjectId);
}

function isFreshSubject(ledger: FindingLedger, value: ConflictClaimSubject): boolean {
  return sameValue(
    captureFindingLifecycleHead(ledger, 'finding', value.findingId),
    value.expectedHead,
  );
}

function failure(
  ...reasonCodes: ConflictVerificationFailureCode[]
): ResolvedConflictAdjudicationPlan {
  return {
    kind: 'undetermined',
    reasonCodes: binarySortedUnique(reasonCodes) as ConflictVerificationFailureCode[],
  };
}

function isCurrentProductProjection(
  ledger: FindingLedger,
  product: Extract<ConflictAdjudicationProposal, { kind: 'promote_holding' }>['proposedProduct'],
): boolean {
  return computeTargetIdentityHash(product.target) === product.targetIdentityHash
    && computeClaimIdentityHash({
      target: product.target,
      familyTag: product.familyTag,
      severity: product.severity,
      title: product.title,
      description: product.description,
      suggestion: product.suggestion,
    }) === product.claimIdentityHash
    && computeSemanticClaimIdentityHash({
      target: product.target,
      title: product.title,
      description: product.description,
    }) === product.semanticClaimIdentityHash
    && product.evidenceRecordIds.every((evidenceId) => (
      ledger.evidenceRecords.filter((record) => record.evidenceId === evidenceId).length === 1
    ));
}

function authorityEnvelope(input: {
  proposal: ConflictAdjudicationProposal;
  proofRecordIds: string[];
  payload: object;
}): { proposalDigest: string; proofRecordIds: string[]; verificationDigest: string } {
  const proposalDigest = findingContentAddress('conflict-adjudication-proposal', input.proposal);
  return {
    proposalDigest,
    proofRecordIds: input.proofRecordIds,
    verificationDigest: findingContentAddress('verified-conflict-adjudication', {
      proposalDigest,
      proofRecordIds: input.proofRecordIds,
      ...input.payload,
    }),
  };
}

function verifyMerge(input: {
  ledger: FindingLedger;
  snapshot: ConflictAdjudicationSnapshot;
  proposal: Extract<ConflictAdjudicationProposal, { kind: 'merge_holding' }>;
}): ResolvedConflictAdjudicationPlan {
  const holding = subject(input.snapshot, input.proposal.holdingSubjectId);
  const target = subject(input.snapshot, input.proposal.targetProductSubjectId);
  if (holding === undefined || target === undefined) {
    return failure('subject_not_found');
  }
  if (holding.role !== 'holding_provisional' || target.role !== 'product_finding') {
    return failure('subject_role_mismatch');
  }
  if (!isFreshSubject(input.ledger, holding) || !isFreshSubject(input.ledger, target)) {
    return failure('head_not_fresh');
  }
  const proofs = referencedProofs(input.ledger, input.proposal.authorityRefIds);
  if (proofs === undefined) {
    return failure('authority_not_found');
  }
  const proof = proofs.find((record) => {
    const proofSubject = record.subject;
    return record.purpose === 'lifecycle_authority'
      && proofSubject.kind === 'finding_claim_identical'
      && proofSubject.adjudicationKind === 'conflict'
      && sameSet(proofSubject.subjectIds, [holding.subjectId, target.subjectId])
      && sameSet(proofSubject.findingIds, [holding.findingId, target.findingId])
      && sameValue(
        [...proofSubject.expectedHeads].sort((a, b) => compareBinaryStrings(a.entityId, b.entityId)),
        [holding.expectedHead, target.expectedHead]
          .sort((a, b) => compareBinaryStrings(a.entityId, b.entityId)),
      )
      && sameSet(
        proofSubject.claimSnapshotDigests,
        [holding.claimSnapshotDigest, target.claimSnapshotDigest],
      )
      && sameSet(proofSubject.rawClaimRefIds, holding.rawClaimLandingIds);
  });
  if (proof === undefined || proof.subject.kind !== 'finding_claim_identical') {
    return failure(proofs.length === 0 ? 'authority_not_found' : 'authority_binding_mismatch');
  }
  const envelope = authorityEnvelope({
    proposal: input.proposal,
    proofRecordIds: proofs.map(({ evidenceId }) => evidenceId),
    payload: {
      conflictSnapshotId: input.snapshot.conflictSnapshotId,
      holdingSubjectId: holding.subjectId,
      targetProductSubjectId: target.subjectId,
    },
  });
  const authority = {
    kind: 'merge_holding' as const,
    conflictSnapshotId: input.snapshot.conflictSnapshotId,
    holdingSubjectId: holding.subjectId,
    holdingFindingId: holding.findingId,
    holdingExpectedHead: structuredClone(holding.expectedHead),
    rawClaimLandingIds: [...holding.rawClaimLandingIds],
    targetProductSubjectId: target.subjectId,
    targetFindingId: target.findingId,
    targetExpectedHead: structuredClone(target.expectedHead),
    exactClaimIdentityDigest: proof.subject.exactClaimIdentityDigest,
    ...envelope,
  } as unknown as Extract<VerifiedConflictAdjudicationAuthority, { kind: 'merge_holding' }>;
  return {
    kind: 'merge_holding',
    authority,
    actionableFix: input.proposal.actionableFix?.trim() || null,
  };
}

function verifyPromotion(input: {
  ledger: FindingLedger;
  snapshot: ConflictAdjudicationSnapshot;
  proposal: Extract<ConflictAdjudicationProposal, { kind: 'promote_holding' }>;
}): ResolvedConflictAdjudicationPlan {
  const holding = subject(input.snapshot, input.proposal.holdingSubjectId);
  if (holding === undefined) {
    return failure('subject_not_found');
  }
  if (holding.role !== 'holding_provisional') {
    return failure('subject_role_mismatch');
  }
  if (!isFreshSubject(input.ledger, holding)) {
    return failure('head_not_fresh');
  }
  if (!isCurrentProductProjection(input.ledger, input.proposal.proposedProduct)) {
    return failure('authority_binding_mismatch');
  }
  const productProjectionDigest = findingContentAddress(
    'product-finding-projection',
    { ...input.proposal.proposedProduct },
  );
  const proofs = referencedProofs(input.ledger, input.proposal.authorityRefIds);
  if (proofs === undefined) {
    return failure('authority_not_found');
  }
  const proof = proofs.find((record) => {
    const proofSubject = record.subject;
    return record.purpose === 'lifecycle_authority'
      && proofSubject.kind === 'finding_claim_supported_after_verification'
      && proofSubject.adjudicationKind === 'conflict'
      && proofSubject.subjectId === holding.subjectId
      && proofSubject.findingId === holding.findingId
      && sameValue(proofSubject.expectedHead, holding.expectedHead)
      && sameSet(proofSubject.rawClaimRefIds, holding.rawClaimLandingIds)
      && proofSubject.productProjectionDigest === productProjectionDigest;
  });
  if (proof === undefined) {
    return failure(proofs.length === 0 ? 'authority_not_found' : 'authority_binding_mismatch');
  }
  const envelope = authorityEnvelope({
    proposal: input.proposal,
    proofRecordIds: proofs.map(({ evidenceId }) => evidenceId),
    payload: {
      conflictSnapshotId: input.snapshot.conflictSnapshotId,
      holdingSubjectId: holding.subjectId,
      productProjectionDigest,
    },
  });
  const authority = {
    kind: 'promote_holding' as const,
    conflictSnapshotId: input.snapshot.conflictSnapshotId,
    holdingSubjectId: holding.subjectId,
    holdingFindingId: holding.findingId,
    holdingExpectedHead: structuredClone(holding.expectedHead),
    rawClaimLandingIds: [...holding.rawClaimLandingIds],
    productProjection: structuredClone(input.proposal.proposedProduct),
    productProjectionDigest,
    ...envelope,
  } as unknown as Extract<VerifiedConflictAdjudicationAuthority, { kind: 'promote_holding' }>;
  return {
    kind: 'promote_holding',
    authority,
    actionableFix: input.proposal.actionableFix?.trim() || null,
  };
}

function verifyTermination(input: {
  ledger: FindingLedger;
  snapshot: ConflictAdjudicationSnapshot;
  proposal: Extract<ConflictAdjudicationProposal, { kind: 'terminate_subject' }>;
}): ResolvedConflictAdjudicationPlan {
  const value = subject(input.snapshot, input.proposal.subjectId);
  if (value === undefined) {
    return failure('subject_not_found');
  }
  if (!isFreshSubject(input.ledger, value)) {
    return failure('head_not_fresh');
  }
  const proofs = referencedProofs(input.ledger, input.proposal.authorityRefIds);
  if (proofs === undefined) {
    return failure('authority_not_found');
  }
  const proof = proofs.find((record) => {
    const proofSubject = record.subject;
    return record.purpose === 'lifecycle_authority'
      && proofSubject.kind === input.proposal.basis
      && proofSubject.adjudicationKind === 'conflict'
      && proofSubject.subjectId === value.subjectId
      && proofSubject.findingId === value.findingId
      && sameValue(proofSubject.expectedHead, value.expectedHead)
      && proofSubject.claimSnapshotDigest === value.claimSnapshotDigest
      && sameSet(proofSubject.rawClaimRefIds, value.rawClaimLandingIds);
  });
  if (proof === undefined) {
    return failure(proofs.length === 0 ? 'authority_not_found' : 'authority_binding_mismatch');
  }
  const envelope = authorityEnvelope({
    proposal: input.proposal,
    proofRecordIds: proofs.map(({ evidenceId }) => evidenceId),
    payload: {
      conflictSnapshotId: input.snapshot.conflictSnapshotId,
      subjectId: value.subjectId,
      basis: input.proposal.basis,
    },
  });
  const authority = {
    kind: 'terminate_subject' as const,
    conflictSnapshotId: input.snapshot.conflictSnapshotId,
    subjectId: value.subjectId,
    subjectRole: value.role,
    findingId: value.findingId,
    subjectExpectedHead: structuredClone(value.expectedHead),
    rawClaimLandingIds: [...value.rawClaimLandingIds],
    basis: input.proposal.basis,
    ...envelope,
  } as unknown as Extract<VerifiedConflictAdjudicationAuthority, { kind: 'terminate_subject' }>;
  return { kind: 'terminate_subject', authority };
}

export function resolveConflictAdjudicationPlan(input: {
  ledger: FindingLedger;
  snapshot: ConflictAdjudicationSnapshot;
  proposal: ConflictAdjudicationProposal;
}): ResolvedConflictAdjudicationPlan {
  const currentConflictHead = captureFindingLifecycleHead(
    input.ledger,
    'conflict',
    input.snapshot.conflictId,
  );
  if (!sameValue(currentConflictHead, input.snapshot.expectedConflictHead)) {
    return failure('snapshot_not_fresh');
  }
  switch (input.proposal.kind) {
    case 'undetermined':
      return failure();
    case 'merge_holding':
      return verifyMerge(input as Parameters<typeof verifyMerge>[0]);
    case 'promote_holding':
      return verifyPromotion(input as Parameters<typeof verifyPromotion>[0]);
    case 'terminate_subject':
      return verifyTermination(input as Parameters<typeof verifyTermination>[0]);
  }
}
