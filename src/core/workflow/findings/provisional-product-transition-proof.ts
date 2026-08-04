import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { computeFindingLifecycleProjectionDigest } from '../../models/finding-lifecycle-identity.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type {
  EngineProofRecord,
  FindingLedger,
  FindingLifecycleOperation,
  FindingObservation,
  ProductFindingEntry,
  ProvisionalFindingEntry,
  RawFinding,
} from './types.js';
import {
  hasSameProductClaim,
  isProvisionalFindingEntry,
  materializeProvisionalFinding,
  productFindingClaimProjection,
} from './finding-entry.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';

export type ProvisionalProductTransitionOperation =
  Extract<FindingLifecycleOperation, 'promote_provisional' | 'reopen_finding'>;

type ProvisionalProductTransitionSubject = Extract<
  EngineProofRecord['subject'],
  { kind: 'finding_provisional_product_transition' }
>;

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sortedTransitionSources(
  transitionRawFindings: readonly RawFinding[],
): ProvisionalProductTransitionSubject['sourceRawFindings'] {
  return transitionRawFindings
    .map((rawFinding) => ({
      rawFindingId: rawFinding.rawFindingId,
      integrityDigest: computeRawFindingIntegrityDigest(rawFinding),
    }))
    .sort((left, right) => (
      compareBinaryStrings(left.rawFindingId, right.rawFindingId)
    ));
}

function transitionPreconditionDigest(
  transitionRawFindings: readonly RawFinding[],
): string {
  return sha256(
    [...transitionRawFindings]
      .sort((left, right) => (
        compareBinaryStrings(left.rawFindingId, right.rawFindingId)
      ))
      .map((rawFinding) => ({
        rawFindingId: rawFinding.rawFindingId,
        targetPrecondition: rawFinding.targetPrecondition ?? null,
      })),
  );
}

export function computeProductFindingClaimDigest(
  finding: ProductFindingEntry,
): string {
  return sha256(productFindingClaimProjection(finding));
}

function assertProductTransitionState(input: {
  operation: ProvisionalProductTransitionOperation;
  product: ProductFindingEntry;
}): void {
  const valid = input.operation === 'promote_provisional'
    ? input.product.status === 'open' && input.product.lifecycle === 'persists'
    : input.product.status === 'open' && input.product.lifecycle === 'reopened';
  if (!valid || input.product.provisional !== undefined) {
    throw new Error(
      `Lifecycle operation "${input.operation}" produced an invalid product state`,
    );
  }
}

function assertObservedTransitionSource(input: {
  observationLedger: FindingLedger;
  intermediate: ProvisionalFindingEntry;
  operation: ProvisionalProductTransitionOperation;
  rawFinding: RawFinding;
}): void {
  const expectedStatus = input.operation === 'promote_provisional'
    ? 'open'
    : 'dismissed';
  const expectedRelation = input.operation === 'promote_provisional'
    ? 'persists'
    : 'reopened';
  const observed = input.observationLedger.findings.find(
    (finding) => finding.id === input.intermediate.id,
  );
  if (
    observed === undefined
    || !isProvisionalFindingEntry(observed)
    || observed.status !== expectedStatus
    || input.intermediate.status !== expectedStatus
    || observed.provisional.stableKey !== input.intermediate.provisional.stableKey
    || observed.provisional.lineageKey !== input.intermediate.provisional.lineageKey
    || input.intermediate.targetIdentityHash === null
    || input.rawFinding.relation !== expectedRelation
    || input.rawFinding.targetFindingId !== input.intermediate.id
    || input.rawFinding.targetIdentityHash !== input.intermediate.targetIdentityHash
    || input.rawFinding.targetPrecondition === undefined
    || !findingMatchesMutationPrecondition(
      input.observationLedger,
      input.rawFinding.targetPrecondition,
    )
  ) {
    throw new Error(
      `Lifecycle operation "${input.operation}" has an ineligible observed provisional transition source`,
    );
  }
}

export interface ObservedProvisionalProductTransitionAssessment {
  provisional: ProvisionalFindingEntry;
  materializedProduct: ProductFindingEntry;
  subject: ProvisionalProductTransitionSubject;
}

export function assessObservedProvisionalProductTransition(input: {
  observationLedger: FindingLedger;
  intermediateLedger: FindingLedger;
  operation: ProvisionalProductTransitionOperation;
  findingId: string;
  transitionRawFindings: readonly RawFinding[];
  product: ProductFindingEntry;
}): ObservedProvisionalProductTransitionAssessment {
  const intermediate = input.intermediateLedger.findings.find(
    (finding) => finding.id === input.findingId,
  );
  if (intermediate === undefined || !isProvisionalFindingEntry(intermediate)) {
    throw new Error(
      `Lifecycle operation "${input.operation}" requires an intermediate provisional finding`,
    );
  }
  if (input.transitionRawFindings.length === 0) {
    throw new Error(
      `Lifecycle operation "${input.operation}" has no provisional transition source`,
    );
  }
  for (const rawFinding of input.transitionRawFindings) {
    assertObservedTransitionSource({
      observationLedger: input.observationLedger,
      intermediate,
      operation: input.operation,
      rawFinding,
    });
  }
  if (intermediate.targetIdentityHash === null) {
    throw new Error(
      `Lifecycle operation "${input.operation}" requires an identified provisional target`,
    );
  }
  const materialized = materializeProvisionalFinding({
    ledger: input.intermediateLedger,
    finding: intermediate,
    transitionRawFindings: input.transitionRawFindings,
  });
  if (materialized.outcome !== 'materialized') {
    throw new Error(
      `Lifecycle operation "${input.operation}" cannot materialize provisional finding "${input.findingId}": ${materialized.reason}`,
    );
  }
  if (!hasSameProductClaim(input.product, materialized.finding)) {
    throw new Error(
      `Lifecycle operation "${input.operation}" product claim does not match materialized evidence`,
    );
  }
  assertProductTransitionState({
    operation: input.operation,
    product: input.product,
  });
  const expectedProductRawFindingIds = [
    ...new Set([
      ...intermediate.rawFindingIds,
      ...input.transitionRawFindings.map((rawFinding) => rawFinding.rawFindingId),
    ]),
  ].sort(compareBinaryStrings);
  if (
    canonicalJson(input.product.rawFindingIds)
      !== canonicalJson(expectedProductRawFindingIds)
  ) {
    throw new Error(
      `Lifecycle operation "${input.operation}" product raw lineage does not match materialized evidence`,
    );
  }
  return {
    provisional: intermediate,
    materializedProduct: materialized.finding,
    subject: {
      kind: 'finding_provisional_product_transition',
      operation: input.operation,
      findingId: input.findingId,
      provisionalStableKey: intermediate.provisional.stableKey,
      provisionalLineageKey: intermediate.provisional.lineageKey,
      targetIdentityHash: intermediate.targetIdentityHash,
      sourceRawFindings: sortedTransitionSources(input.transitionRawFindings),
      expectedProductRawFindingIds,
      transitionPreconditionDigest: transitionPreconditionDigest(
        input.transitionRawFindings,
      ),
      expectedIntermediateHead: {
        revision: intermediate.revision,
        projectionDigest: computeFindingLifecycleProjectionDigest(intermediate),
      },
      materializedProductClaimDigest: computeProductFindingClaimDigest(
        materialized.finding,
      ),
    },
  };
}

export function issueProvisionalProductTransitionAuthorityProof(input: {
  observationLedger: FindingLedger;
  intermediateLedger: FindingLedger;
  operation: ProvisionalProductTransitionOperation;
  findingId: string;
  transitionRawFindings: readonly RawFinding[];
  product: ProductFindingEntry;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  reviewScopeSnapshotId: string;
  observation: FindingObservation;
}): EngineProofRecord {
  const assessment = assessObservedProvisionalProductTransition(input);
  const observed = input.observationLedger.findings.find(
    (finding) => finding.id === input.findingId,
  );
  if (observed === undefined) {
    throw new Error(
      `Lifecycle proof references unknown observed finding "${input.findingId}"`,
    );
  }
  return createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: input.workflowName,
    runId: input.runId,
    scopeIdentity: input.scopeIdentity,
    snapshotId: input.reviewScopeSnapshotId,
    claimIdentityHash: assessment.materializedProduct.claimIdentityHash,
    targetFindingId: input.findingId,
    subject: assessment.subject,
    dependencyDigests: [
      computeFindingLifecycleProjectionDigest(observed),
    ],
    resultDigest: assessment.subject.materializedProductClaimDigest,
    issuedAt: input.observation.timestamp,
  });
}

export function verifyProvisionalProductTransitionAuthorityProof(input: {
  ledger: FindingLedger;
  operation: ProvisionalProductTransitionOperation;
  findingId: string;
  transitionRawFindings: readonly RawFinding[];
  after: ProductFindingEntry;
  proof: EngineProofRecord;
}): void {
  const subject = input.proof.subject;
  if (
    input.proof.purpose !== 'lifecycle_authority'
    || input.proof.verifierId !== 'takt.finding-lifecycle-policy'
    || input.proof.verifierVersion !== '1'
    || subject.kind !== 'finding_provisional_product_transition'
    || subject.operation !== input.operation
    || subject.findingId !== input.findingId
    || input.proof.targetFindingId !== input.findingId
  ) {
    throw new Error('Provisional product transition proof does not match its operation target');
  }
  const provisional = input.ledger.findings.find(
    (finding) => finding.id === input.findingId,
  );
  if (
    provisional === undefined
    || !isProvisionalFindingEntry(provisional)
    || subject.provisionalStableKey !== provisional.provisional.stableKey
    || subject.provisionalLineageKey !== provisional.provisional.lineageKey
    || subject.targetIdentityHash !== provisional.targetIdentityHash
    || subject.expectedIntermediateHead.revision !== provisional.revision
    || subject.expectedIntermediateHead.projectionDigest
      !== computeFindingLifecycleProjectionDigest(provisional)
  ) {
    throw new Error('Provisional product transition proof has a stale intermediate head');
  }
  if (
    canonicalJson(subject.sourceRawFindings)
      !== canonicalJson(sortedTransitionSources(input.transitionRawFindings))
    || subject.transitionPreconditionDigest
      !== transitionPreconditionDigest(input.transitionRawFindings)
  ) {
    throw new Error('Provisional product transition proof has stale transition evidence');
  }
  if (
    canonicalJson(input.after.rawFindingIds)
      !== canonicalJson(subject.expectedProductRawFindingIds)
  ) {
    throw new Error('Provisional product transition proof does not match the product raw lineage');
  }
  const materialized = materializeProvisionalFinding({
    ledger: input.ledger,
    finding: provisional,
    transitionRawFindings: input.transitionRawFindings,
  });
  if (materialized.outcome !== 'materialized') {
    throw new Error(
      `Provisional product transition proof cannot materialize "${input.findingId}": ${materialized.reason}`,
    );
  }
  const afterClaimDigest = computeProductFindingClaimDigest(input.after);
  if (
    subject.materializedProductClaimDigest !== afterClaimDigest
    || subject.materializedProductClaimDigest
      !== computeProductFindingClaimDigest(materialized.finding)
    || input.proof.resultDigest !== subject.materializedProductClaimDigest
    || input.proof.claimIdentityHash !== input.after.claimIdentityHash
  ) {
    throw new Error('Provisional product transition proof does not match the product claim');
  }
  assertProductTransitionState({
    operation: input.operation,
    product: input.after,
  });
}
