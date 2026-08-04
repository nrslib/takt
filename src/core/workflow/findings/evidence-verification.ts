import type {
  FindingEvidenceRecord,
  RawFindingEvidence,
} from './types.js';
import { verifyFileQuoteEvidence } from './admission-validation.js';
import {
  computeFileQuoteEvidenceId,
  type EngineProofRecordRegistry,
  type EngineProofVerificationContext,
  type EngineProofVerifierRegistry,
  verifyEngineProofEvidence,
} from './evidence-domain.js';

type EvidenceFailure =
  | { outcome: 'quote-mismatch'; reason: string }
  | { outcome: 'mismatch'; reason: string }
  | { outcome: 'protocol-anomaly'; reason: string }
  | { outcome: 'resource_exhausted'; reason: string }
  | { outcome: 'stale-snapshot'; reason: string }
  | { outcome: 'unverifiable'; reason: string; error?: unknown };

export type EvidenceVerificationOutcome =
  | { outcome: 'match'; records: FindingEvidenceRecord[] }
  | (EvidenceFailure & { failureLevel: 'set' })
  | (EvidenceFailure & {
      failureLevel: 'item';
      failedEvidence: RawFindingEvidence;
      failedEvidenceIndex: number;
    });

export function verifyFindingEvidenceSet(input: {
  cwd: string;
  evidence: readonly RawFindingEvidence[];
  expectedSnapshotId: string;
  claimIdentityHash: string;
  targetFindingId: string | null;
  proofRegistry: EngineProofRecordRegistry;
  proofVerifiers: EngineProofVerifierRegistry;
  proofContext: Omit<
    EngineProofVerificationContext,
    'claimIdentityHash' | 'snapshotId' | 'targetFindingId'
  >;
}): EvidenceVerificationOutcome {
  if (input.evidence.length === 0) {
    return {
      outcome: 'mismatch',
      failureLevel: 'set',
      reason: 'no mechanically verifiable evidence was supplied',
    };
  }
  const records: FindingEvidenceRecord[] = [];
  for (const [failedEvidenceIndex, evidence] of input.evidence.entries()) {
    if (evidence.kind === 'file_quote') {
      const verification = verifyFileQuoteEvidence(
        input.cwd,
        evidence,
        input.expectedSnapshotId,
      );
      if (verification.outcome !== 'match') {
        return {
          ...verification,
          failureLevel: 'item',
          failedEvidence: evidence,
          failedEvidenceIndex,
        };
      }
      records.push({
        ...evidence,
        evidenceId: computeFileQuoteEvidenceId({
          claimIdentityHash: input.claimIdentityHash,
          path: evidence.path,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
          verbatimExcerpt: evidence.verbatimExcerpt,
          snapshotId: evidence.snapshotId,
          fileHash: verification.fileHash,
        }),
        claimIdentityHash: input.claimIdentityHash,
        fileHash: verification.fileHash,
      });
      continue;
    }
    const verification = verifyEngineProofEvidence(
      evidence,
      {
        ...input.proofContext,
        claimIdentityHash: input.claimIdentityHash,
        snapshotId: input.expectedSnapshotId,
        targetFindingId: input.targetFindingId,
      },
      input.proofRegistry,
      input.proofVerifiers,
    );
    if (verification.outcome !== 'match') {
      return {
        ...verification,
        failureLevel: 'item',
        failedEvidence: evidence,
        failedEvidenceIndex,
      };
    }
    records.push(verification.record);
  }
  return { outcome: 'match', records };
}
