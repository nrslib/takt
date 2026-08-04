import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  binarySortedUnique,
  computeConflictRawClaimSnapshotDigest,
  computeRawProvisionalExactClaimIdentityDigest,
  computeVerifiedRawProvisionalIdentityDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { computeFindingEvidenceBindingId } from '../../models/finding-lifecycle-identity.js';
import { computeRawFindingIntegrityDigest } from '../../models/finding-raw-integrity.js';
import type {
  EngineProofRecord,
  FindingEvidenceBinding,
  FindingEvidenceContributionOrigin,
  FindingLedger,
  ProvisionalFindingEntry,
  RawCanonicalSnapshot,
  RawFinding,
  VerifiedRawProvisionalIdentityAuthority,
} from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';

interface IssuedRawProvisionalIdentityProof {
  proofRecord: EngineProofRecord;
  lifecycleEvidenceBinding: FindingEvidenceBinding;
  authority: VerifiedRawProvisionalIdentityAuthority;
}

function computeProvisionalClaimSnapshotDigest(
  finding: ProvisionalFindingEntry,
): string {
  return findingContentAddress('conflict-finding-claim-snapshot', {
    findingId: finding.id,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    rawFindingIds: binarySortedUnique(finding.rawFindingIds),
    evidenceIds: binarySortedUnique(finding.evidenceIds),
  });
}

function exactOne<Value>(values: readonly Value[], description: string): Value {
  if (values.length !== 1) {
    throw new Error(`Raw provisional identity requires exactly one ${description}; found ${values.length}`);
  }
  return values[0]!;
}

function assertExactIdentity(
  raw: RawFinding,
  snapshot: RawCanonicalSnapshot,
  target: ProvisionalFindingEntry,
): void {
  if (
    target.status !== 'open'
    || raw.targetIdentityHash !== snapshot.targetIdentityHash
    || raw.claimIdentityHash !== snapshot.claimIdentityHash
    || raw.semanticClaimIdentityHash !== snapshot.semanticClaimIdentityHash
    || target.targetIdentityHash !== snapshot.targetIdentityHash
    || target.claimIdentityHash !== snapshot.claimIdentityHash
    || target.semanticClaimIdentityHash !== snapshot.semanticClaimIdentityHash
  ) {
    throw new Error(
      `Raw finding "${raw.rawFindingId}" does not have exact three-hash identity with provisional "${target.id}"`,
    );
  }
}

export function issueRawProvisionalIdentityProof(input: {
  ledger: FindingLedger;
  rawFindingId: string;
  targetFindingId: string;
  runId: string;
  scopeIdentity: string;
  contributionOrigin: FindingEvidenceContributionOrigin;
  issuedAt: string;
}): IssuedRawProvisionalIdentityProof {
  const raw = exactOne(
    input.ledger.rawFindings.filter((candidate) => candidate.rawFindingId === input.rawFindingId),
    `raw finding "${input.rawFindingId}"`,
  );
  const snapshot = exactOne(
    input.ledger.rawCanonicalSnapshots.filter(
      (candidate) => candidate.rawFindingId === input.rawFindingId,
    ),
    `canonical snapshot for "${input.rawFindingId}"`,
  );
  const target = exactOne(
    input.ledger.findings.filter(
      (candidate): candidate is ProvisionalFindingEntry => (
        candidate.id === input.targetFindingId && candidate.provisional !== undefined
      ),
    ),
    `provisional target "${input.targetFindingId}"`,
  );
  assertExactIdentity(raw, snapshot, target);
  const expectedTargetHead = captureFindingLifecycleHead(
    input.ledger,
    'finding',
    target.id,
  );
  if (expectedTargetHead === undefined) {
    throw new Error(`Provisional target "${target.id}" has no lifecycle head`);
  }
  const rawClaimSnapshotDigest = computeConflictRawClaimSnapshotDigest(snapshot);
  const targetClaimSnapshotDigest = computeProvisionalClaimSnapshotDigest(target);
  const sourceEvidenceBindingIds = input.ledger.evidenceBindings
    .filter((binding) => binding.sourceRawFindingId === raw.rawFindingId)
    .map(({ bindingId }) => bindingId)
    .sort(compareBinaryStrings);
  const exactClaimIdentityDigest = computeRawProvisionalExactClaimIdentityDigest(snapshot);
  const subject = {
    kind: 'raw_provisional_claim_identical' as const,
    rawFindingId: raw.rawFindingId,
    rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
    rawPayloadDigest: snapshot.rawPayloadDigest,
    rawClaimSnapshotDigest,
    targetFindingId: target.id,
    targetExpectedHead: expectedTargetHead,
    targetClaimSnapshotDigest,
    targetIdentityHash: snapshot.targetIdentityHash,
    claimIdentityHash: snapshot.claimIdentityHash,
    semanticClaimIdentityHash: snapshot.semanticClaimIdentityHash,
    sourceEvidenceBindingIds,
    exactClaimIdentityDigest,
  };
  const proofRecord = createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'lifecycle_authority',
    verifierId: 'takt.finding-lifecycle-policy',
    verifierVersion: '1',
    workflowName: input.ledger.workflowName,
    runId: input.runId,
    scopeIdentity: input.scopeIdentity,
    snapshotId: snapshot.rawCanonicalSnapshotId,
    targetFindingId: target.id,
    claimIdentityHash: snapshot.claimIdentityHash,
    dependencyDigests: binarySortedUnique([
      expectedTargetHead.projectionDigest,
      rawClaimSnapshotDigest,
      targetClaimSnapshotDigest,
    ]),
    resultDigest: exactClaimIdentityDigest,
    subject,
    issuedAt: input.issuedAt,
  });
  const bindingPayload = {
    evidenceId: proofRecord.evidenceId,
    claimIdentityHash: raw.claimIdentityHash,
    sourceRawFindingId: raw.rawFindingId,
    sourceRawIntegrityDigest: computeRawFindingIntegrityDigest(raw),
    contributionOrigin: input.contributionOrigin,
    operation: 'attach_raw_to_provisional' as const,
    target: {
      entityKind: 'finding' as const,
      entityId: target.id,
      expectedHead: expectedTargetHead,
    },
  };
  const lifecycleEvidenceBinding = {
    bindingId: computeFindingEvidenceBindingId(bindingPayload),
    ...bindingPayload,
  };
  const verificationDigest = computeVerifiedRawProvisionalIdentityDigest({
    proofRecordId: proofRecord.proofId,
    rawFindingId: raw.rawFindingId,
    rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
    rawPayloadDigest: snapshot.rawPayloadDigest,
    rawClaimSnapshotDigest,
    targetFindingId: target.id,
    expectedTargetHead,
    targetClaimSnapshotDigest,
    sourceEvidenceBindingIds,
    lifecycleEvidenceBindingId: lifecycleEvidenceBinding.bindingId,
    exactClaimIdentityDigest,
  });
  return {
    proofRecord,
    lifecycleEvidenceBinding,
    authority: {
      kind: 'verified_raw_provisional_identity',
      rawFindingId: raw.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      rawClaimSnapshotDigest,
      targetFindingId: target.id,
      expectedTargetHead,
      targetClaimSnapshotDigest,
      proofRecordId: proofRecord.proofId,
      lifecycleEvidenceBindingId: lifecycleEvidenceBinding.bindingId,
      verificationDigest,
    },
  };
}
