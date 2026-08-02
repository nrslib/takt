import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  binarySortedUnique,
  computeRawPayloadDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  ProductFindingProjection,
  ResolvedTerminalAdjudicationPlan,
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationEpisode,
  TerminalAdjudicationProposal,
  TerminalVerificationFailureCode,
  VerifiedTerminalAdjudicationAuthority,
} from '../../models/finding-contract-types.js';
import type { EngineProofRecord, FindingLedger } from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../../models/finding-claim-identity.js';
import { findingScopePredicateResult } from '../../models/finding-scope-predicate.js';
import { findingScopeBindingMatchesCurrentDependencies } from '../../models/finding-scope-binding-dependencies.js';
import { computeWorkflowTaskDigest } from './task-scope-adjudication.js';

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(compareBinaryStrings);
  const b = [...right].sort(compareBinaryStrings);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function failure(...codes: TerminalVerificationFailureCode[]): ResolvedTerminalAdjudicationPlan {
  return { kind: 'undetermined', reasonCodes: binarySortedUnique(codes) as TerminalVerificationFailureCode[] };
}

function exactProofs(ledger: FindingLedger, referenceIds: readonly string[]): EngineProofRecord[] | undefined {
  const proofs: EngineProofRecord[] = [];
  for (const referenceId of referenceIds) {
    const matches = ledger.evidenceRecords.filter((record): record is EngineProofRecord => (
      record.kind === 'engine_proof'
      && (record.evidenceId === referenceId || record.proofId === referenceId)
    ));
    if (matches.length !== 1) {
      return undefined;
    }
    proofs.push(matches[0]!);
  }
  return [...new Map(proofs.map((proof) => [proof.evidenceId, proof])).values()]
    .sort((left, right) => compareBinaryStrings(left.evidenceId, right.evidenceId));
}

function sourceIntegrity(ledger: FindingLedger, candidate: TerminalAdjudicationCandidateSnapshot): boolean {
  return candidate.sourceClaims.every((source) => {
    const raw = ledger.rawFindings.filter(({ rawFindingId }) => rawFindingId === source.rawFindingId);
    const snapshot = ledger.rawCanonicalSnapshots.filter(
      ({ rawCanonicalSnapshotId }) => rawCanonicalSnapshotId === source.rawCanonicalSnapshotId,
    );
    return raw.length === 1
      && snapshot.length === 1
      && snapshot[0]!.rawPayloadDigest === source.rawPayloadDigest
      && computeRawPayloadDigest(raw[0]!) === source.rawPayloadDigest;
  });
}

function envelope(input: {
  episode: TerminalAdjudicationEpisode;
  proposal: TerminalAdjudicationProposal;
  proofRecordIds: string[];
  payload: object;
}) {
  const proposalDigest = findingContentAddress('terminal-adjudication-proposal', input.proposal);
  return {
    proposalDigest,
    proofRecordIds: input.proofRecordIds,
    verificationDigest: findingContentAddress('verified-terminal-adjudication', {
      episodeId: input.episode.episodeId,
      proposalDigest,
      proofRecordIds: input.proofRecordIds,
      ...input.payload,
    }),
  };
}

function productDigest(product: ProductFindingProjection): string {
  return findingContentAddress('product-finding-projection', { ...product });
}

function isCurrentProductProjection(
  ledger: FindingLedger,
  product: ProductFindingProjection,
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

export function resolveTerminalAdjudicationPlan(input: {
  ledger: FindingLedger;
  episode: TerminalAdjudicationEpisode;
  candidate: TerminalAdjudicationCandidateSnapshot;
  proposal: TerminalAdjudicationProposal;
  workflowTask: string;
  findingContractDigest: string;
  reviewScopeSnapshotId: string;
  adjudicationTaskId: string;
}): ResolvedTerminalAdjudicationPlan {
  if (input.episode.candidateSnapshotDigest !== input.candidate.candidateSnapshotDigest) {
    return failure('candidate_not_found');
  }
  if (!sameValue(
    captureFindingLifecycleHead(input.ledger, 'finding', input.episode.findingId),
    input.episode.expectedHead,
  )) {
    return failure('head_not_fresh');
  }
  if (!sourceIntegrity(input.ledger, input.candidate)) {
    return failure('source_claim_coverage_mismatch');
  }
  if (input.proposal.kind === 'undetermined') {
    return failure();
  }
  if (
    input.proposal.kind === 'promote_independent'
    && !isCurrentProductProjection(input.ledger, input.proposal.proposedProduct)
  ) {
    return failure('positive_evidence_not_current');
  }
  const sourceClaimRefIds = input.candidate.sourceClaims.map(({ sourceClaimRefId }) => sourceClaimRefId);
  const proofs = exactProofs(input.ledger, input.proposal.authorityRefIds);
  if (input.proposal.kind === 'dismiss'
    && (input.proposal.basis === 'outside_contract_jurisdiction'
      || input.proposal.basis === 'outside_task_scope')) {
    const bindings = input.proposal.authorityRefIds.flatMap((referenceId) => (
      input.ledger.findingScopeBindings.filter((binding) => binding.bindingId === referenceId)
    ));
    const expectedSource = input.proposal.basis === 'outside_task_scope'
      ? 'workflow_task_scope'
      : 'finding_contract_scope';
    const workflowTaskDigest = computeWorkflowTaskDigest(input.workflowTask);
    if (input.proposal.authorityRefIds.length === 0
      || bindings.length !== input.proposal.authorityRefIds.length
      || bindings.some((binding) => binding.findingId !== input.candidate.findingId
        || binding.source !== expectedSource
        || binding.workflowTaskDigest !== workflowTaskDigest
        || !findingScopeBindingMatchesCurrentDependencies({
          binding,
          workflowTaskDigest,
          findingContractDigest: input.findingContractDigest,
          reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        })
        || !sameValue(binding.expectedHead, input.candidate.expectedHead)
        || findingScopePredicateResult({
          predicate: binding.predicate,
          finding: input.ledger.findings.find(({ id }) => id === binding.findingId)!,
        }) !== 'outside')) {
      return failure('scope_binding_not_found');
    }
    if (input.proposal.basis === 'outside_task_scope' && input.workflowTask.length === 0) {
      return failure('scope_binding_not_found');
    }
    const scopeBindingIds = bindings.map(({ bindingId }) => bindingId).sort(compareBinaryStrings);
    const authority = {
      kind: 'dismiss' as const,
      episodeId: input.episode.episodeId,
      findingId: input.candidate.findingId,
      expectedHead: structuredClone(input.candidate.expectedHead),
      sourceClaimRefIds,
      basis: input.proposal.basis,
      scopeBindingIds,
      ...(input.proposal.basis === 'outside_task_scope' ? {
        taskQuote: input.workflowTask,
        workflowTaskDigest,
        adjudicationTaskId: input.adjudicationTaskId,
      } : {}),
      ...envelope({
        episode: input.episode,
        proposal: input.proposal,
        proofRecordIds: [],
        payload: { basis: input.proposal.basis, scopeBindingIds },
      }),
    } as unknown as Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'dismiss' }>;
    return { kind: 'dismiss', authority };
  }
  if (proofs === undefined || proofs.length === 0) {
    return failure('authority_not_found');
  }
  if (input.proposal.kind === 'promote_independent') {
    const projectionDigest = productDigest(input.proposal.proposedProduct);
    const proof = proofs.find((record) => record.purpose === 'lifecycle_authority'
      && record.subject.kind === 'finding_claim_supported_after_verification'
      && record.subject.adjudicationKind === 'terminal'
      && record.subject.subjectId === input.candidate.candidateSnapshotDigest
      && record.subject.findingId === input.candidate.findingId
      && sameValue(record.subject.expectedHead, input.candidate.expectedHead)
      && sameSet(record.subject.rawClaimRefIds, sourceClaimRefIds)
      && record.subject.productProjectionDigest === projectionDigest);
    if (proof === undefined) {
      return failure('authority_binding_mismatch');
    }
    const authority = {
      kind: 'promote_independent' as const,
      episodeId: input.episode.episodeId,
      findingId: input.candidate.findingId,
      expectedHead: structuredClone(input.candidate.expectedHead),
      sourceClaimRefIds,
      productProjection: structuredClone(input.proposal.proposedProduct),
      productProjectionDigest: projectionDigest,
      ...envelope({ episode: input.episode, proposal: input.proposal, proofRecordIds: proofs.map(({ evidenceId }) => evidenceId), payload: { projectionDigest } }),
    } as unknown as Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'promote_independent' }>;
    return { kind: 'promote_independent', authority };
  }
  if (input.proposal.kind === 'merge_existing') {
    const targetRefId = input.proposal.targetRefId;
    const target = input.candidate.targetCandidates.find(
      (candidate) => candidate.targetRefId === targetRefId,
    );
    if (target === undefined
      || !sameValue(captureFindingLifecycleHead(input.ledger, 'finding', target.findingId), target.expectedHead)) {
      return failure('target_not_found');
    }
    const proof = proofs.find((record) => record.purpose === 'lifecycle_authority'
      && record.subject.kind === 'finding_claim_identical'
      && record.subject.adjudicationKind === 'terminal'
      && sameSet(record.subject.subjectIds, [input.candidate.candidateSnapshotDigest, target.targetRefId])
      && sameSet(record.subject.findingIds, [input.candidate.findingId, target.findingId])
      && sameSet(record.subject.rawClaimRefIds, sourceClaimRefIds));
    if (proof === undefined || proof.subject.kind !== 'finding_claim_identical') {
      return failure('authority_binding_mismatch');
    }
    const authority = {
      kind: 'merge_existing' as const,
      episodeId: input.episode.episodeId,
      findingId: input.candidate.findingId,
      expectedHead: structuredClone(input.candidate.expectedHead),
      sourceClaimRefIds,
      targetRefId: target.targetRefId,
      targetFindingId: target.findingId,
      targetExpectedHead: structuredClone(target.expectedHead),
      exactClaimIdentityDigest: proof.subject.exactClaimIdentityDigest,
      ...envelope({ episode: input.episode, proposal: input.proposal, proofRecordIds: proofs.map(({ evidenceId }) => evidenceId), payload: { targetRefId: target.targetRefId } }),
    } as unknown as Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'merge_existing' }>;
    return { kind: 'merge_existing', authority };
  }
  const expectedProofKind = input.proposal.basis === 'no_issue_after_verification'
    ? 'finding_no_issue_after_verification'
    : 'finding_claim_refuted';
  const proof = proofs.find((record) => record.purpose === 'lifecycle_authority'
    && record.subject.kind === expectedProofKind
    && record.subject.adjudicationKind === 'terminal'
    && record.subject.subjectId === input.candidate.candidateSnapshotDigest
    && record.subject.findingId === input.candidate.findingId
    && sameValue(record.subject.expectedHead, input.candidate.expectedHead)
    && sameSet(record.subject.rawClaimRefIds, sourceClaimRefIds));
  if (proof === undefined) {
    return failure('authority_binding_mismatch');
  }
  const authority = {
    kind: 'dismiss' as const,
    episodeId: input.episode.episodeId,
    findingId: input.candidate.findingId,
    expectedHead: structuredClone(input.candidate.expectedHead),
    sourceClaimRefIds,
    basis: input.proposal.basis,
    scopeBindingIds: [],
    ...envelope({ episode: input.episode, proposal: input.proposal, proofRecordIds: proofs.map(({ evidenceId }) => evidenceId), payload: { basis: input.proposal.basis } }),
  } as unknown as Extract<VerifiedTerminalAdjudicationAuthority, { kind: 'dismiss' }>;
  return { kind: 'dismiss', authority };
}
