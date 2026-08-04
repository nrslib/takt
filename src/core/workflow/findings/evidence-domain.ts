import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
export { computeClaimIdentityHash } from '../../models/finding-claim-identity.js';
import {
  canonicalRawFindingEvidenceIdentity,
  compareRawFindingEvidence,
  computeEngineProofRecordId,
  computeFileQuoteEvidenceRecordId,
  findingEvidenceRecordIdentityViolation,
} from '../../models/finding-evidence-record.js';
import type {
  EngineProofEvidence,
  EngineProofRecord,
  EngineProofSubject,
  FindingLedger,
  FindingEvidenceRecord,
  RawFindingEvidence,
} from './types.js';

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function computeEvidenceSetHash(evidenceIds: readonly string[]): string {
  return sha256({
    domain: 'finding-evidence-set',
    version: 1,
    evidenceIds: [...new Set(evidenceIds)].sort(compareBinaryStrings),
  });
}

export function computeFileQuoteEvidenceId(input: {
  claimIdentityHash: string;
  path: string;
  startLine: number;
  endLine: number;
  verbatimExcerpt: string;
  snapshotId: string;
  fileHash: string;
}): string {
  return computeFileQuoteEvidenceRecordId({
    kind: 'file_quote',
    ...input,
  });
}

export { computeEngineProofRecordId };

export interface EngineProofRecordRegistry {
  get(proofId: string): EngineProofRecord | undefined;
}

export interface EngineProofVerificationContext {
  cwd: string;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  snapshotId: string;
  claimIdentityHash: string;
  targetFindingId: string | null;
}

export type EngineProofSubjectVerification =
  | {
      outcome: 'evaluated';
      predicateSatisfied: boolean;
      dependencyDigests: string[];
      resultDigest: string;
    }
  | { outcome: 'unsupported'; reason: string }
  | { outcome: 'unverifiable'; reason: string; error?: unknown }
  | { outcome: 'invalid-subject'; reason: string };

export interface EngineProofVerifier {
  readonly verifierId: string;
  readonly verifierVersion: string;
  verify(
    subject: EngineProofSubject,
    context: EngineProofVerificationContext,
  ): EngineProofSubjectVerification;
}

export interface EngineProofVerifierRegistry {
  get(verifierId: string, verifierVersion: string): EngineProofVerifier | undefined;
}

export type EngineProofVerification =
  | { outcome: 'match'; record: EngineProofRecord }
  | { outcome: 'mismatch'; reason: string }
  | { outcome: 'protocol-anomaly'; reason: string };

export function createLedgerEngineProofRegistry(
  ledger: FindingLedger,
): EngineProofRecordRegistry {
  const records = new Map(
    ledger.evidenceRecords.flatMap((record) => (
      record.kind === 'engine_proof'
        ? [[record.proofId, structuredClone(record)] as const]
        : []
    )),
  );
  return Object.freeze({
    get(proofId: string): EngineProofRecord | undefined {
      const record = records.get(proofId);
      return record === undefined ? undefined : structuredClone(record);
    },
  });
}

export function createEngineProofVerifierRegistry(
  verifiers: readonly EngineProofVerifier[],
): EngineProofVerifierRegistry {
  const byIdentity = new Map<string, EngineProofVerifier>();
  for (const verifier of verifiers) {
    const identity = canonicalJson([verifier.verifierId, verifier.verifierVersion]);
    if (byIdentity.has(identity)) {
      throw new Error(
        `Duplicate engine proof verifier "${verifier.verifierId}@${verifier.verifierVersion}"`,
      );
    }
    byIdentity.set(identity, verifier);
  }
  return Object.freeze({
    get(verifierId: string, verifierVersion: string): EngineProofVerifier | undefined {
      return byIdentity.get(canonicalJson([verifierId, verifierVersion]));
    },
  });
}

export function verifyEngineProofEvidence(
  evidence: EngineProofEvidence,
  expected: EngineProofVerificationContext,
  registry: EngineProofRecordRegistry,
  verifiers: EngineProofVerifierRegistry,
): EngineProofVerification {
  const record = registry.get(evidence.proofId);
  if (record === undefined) {
    return { outcome: 'mismatch', reason: `engine proof "${evidence.proofId}" is not registered` };
  }
  const identityViolation = findingEvidenceRecordIdentityViolation(record);
  if (identityViolation !== undefined) {
    return { outcome: 'protocol-anomaly', reason: identityViolation };
  }
  const verifier = verifiers.get(record.verifierId, record.verifierVersion);
  if (verifier === undefined) {
    return {
      outcome: 'mismatch',
      reason: `engine proof verifier "${record.verifierId}@${record.verifierVersion}" is not registered`,
    };
  }
  const mismatches = [
    record.purpose === 'claim_evidence' ? undefined : 'purpose',
    record.proofId === evidence.proofId ? undefined : 'proofId',
    record.evidenceId === record.proofId ? undefined : 'evidenceId/proofId',
    record.workflowName === expected.workflowName ? undefined : 'workflowName',
    record.runId === expected.runId ? undefined : 'runId',
    record.scopeIdentity === expected.scopeIdentity ? undefined : 'scopeIdentity',
    record.snapshotId === expected.snapshotId ? undefined : 'snapshotId',
    record.claimIdentityHash === expected.claimIdentityHash ? undefined : 'claimIdentityHash',
    record.targetFindingId === expected.targetFindingId ? undefined : 'targetFindingId',
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    return {
      outcome: 'mismatch',
      reason: `engine proof "${evidence.proofId}" binding mismatch: ${mismatches.join(', ')}`,
    };
  }
  const verification = verifier.verify(record.subject, expected);
  if (verification.outcome === 'invalid-subject') {
    return { outcome: 'mismatch', reason: verification.reason };
  }
  if (verification.outcome !== 'evaluated') {
    return { outcome: 'mismatch', reason: verification.reason };
  }
  if (!verification.predicateSatisfied) {
    return {
      outcome: 'mismatch',
      reason: `engine proof "${evidence.proofId}" predicate is no longer satisfied`,
    };
  }
  const expectedDependencies = [...new Set(record.dependencyDigests)].sort(compareBinaryStrings);
  const actualDependencies = [...new Set(verification.dependencyDigests)].sort(compareBinaryStrings);
  const resultMismatches = [
    canonicalJson(actualDependencies) === canonicalJson(expectedDependencies)
      ? undefined
      : 'dependencyDigests',
    record.resultDigest === verification.resultDigest ? undefined : 'resultDigest',
  ].filter((value): value is string => value !== undefined);
  if (resultMismatches.length > 0) {
    return {
      outcome: 'mismatch',
      reason: `engine proof "${evidence.proofId}" verification mismatch: ${resultMismatches.join(', ')}`,
    };
  }
  return { outcome: 'match', record };
}

export function evidenceRecordId(record: FindingEvidenceRecord): string {
  return record.evidenceId;
}

export function deduplicateRawEvidence(
  evidence: readonly RawFindingEvidence[],
): RawFindingEvidence[] {
  const byIdentity = new Map<string, RawFindingEvidence>();
  for (const item of evidence) {
    const identity = canonicalRawFindingEvidenceIdentity(item);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, item);
    }
  }
  return [...byIdentity.values()]
    .sort(compareRawFindingEvidence)
    .map((item) => structuredClone(item));
}
