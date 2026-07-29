import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { normalizeRfc3339Timestamp } from './rfc3339.js';
import type {
  EngineProofRecord,
  FindingEvidenceRecord,
  RawFindingEvidence,
  VerifiedFileQuoteEvidenceRecord,
} from './finding-types.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** RawFinding.evidence set の重複排除と順序検証で共有する canonical identity。 */
export function canonicalRawFindingEvidenceIdentity(
  evidence: RawFindingEvidence,
): string {
  return canonicalJson(evidence);
}

export function compareRawFindingEvidence(
  left: RawFindingEvidence,
  right: RawFindingEvidence,
): number {
  return compareBinaryStrings(
    canonicalRawFindingEvidenceIdentity(left),
    canonicalRawFindingEvidenceIdentity(right),
  );
}

function hashCanonicalPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export type FileQuoteEvidenceRecordPayload = Omit<
  VerifiedFileQuoteEvidenceRecord,
  'evidenceId'
>;

export function computeFileQuoteEvidenceRecordId(
  record: FileQuoteEvidenceRecordPayload,
): string {
  return hashCanonicalPayload({
    domain: 'finding-file-quote-evidence',
    version: 1,
    ...record,
  });
}

export type EngineProofRecordPayload =
  EngineProofRecord extends infer Record
    ? Record extends EngineProofRecord
      ? Omit<Record, 'evidenceId' | 'proofId'>
      : never
    : never;

/**
 * Engine proof の proofId と evidenceId は同じ content address を表す。
 * registry lookup と ledger reference で別の任意 ID を許さない。
 */
export function computeEngineProofRecordId(
  record: EngineProofRecordPayload,
): string {
  return hashCanonicalPayload({
    domain: 'finding-engine-proof-evidence',
    version: 1,
    ...record,
  });
}

/**
 * Engine proof record の唯一の canonical constructor。
 * issuedAt は content address の計算前に UTC の RFC 3339 表現へ正規化する。
 */
export function createEngineProofRecord(
  record: EngineProofRecordPayload,
): EngineProofRecord {
  const payload: EngineProofRecordPayload = {
    ...structuredClone(record),
    issuedAt: normalizeRfc3339Timestamp(record.issuedAt),
  };
  const proofId = computeEngineProofRecordId(payload);
  return {
    evidenceId: proofId,
    proofId,
    ...payload,
  };
}

export function computeFindingEvidenceRecordId(
  record: FindingEvidenceRecord,
): string {
  if (record.kind === 'file_quote') {
    return computeFileQuoteEvidenceRecordId({
      kind: record.kind,
      path: record.path,
      startLine: record.startLine,
      endLine: record.endLine,
      verbatimExcerpt: record.verbatimExcerpt,
      snapshotId: record.snapshotId,
      claimIdentityHash: record.claimIdentityHash,
      fileHash: record.fileHash,
    });
  }
  const common = {
    kind: record.kind,
    verifierId: record.verifierId,
    verifierVersion: record.verifierVersion,
    workflowName: record.workflowName,
    runId: record.runId,
    scopeIdentity: record.scopeIdentity,
    snapshotId: record.snapshotId,
    targetFindingId: record.targetFindingId,
    dependencyDigests: record.dependencyDigests,
    resultDigest: record.resultDigest,
    issuedAt: record.issuedAt,
  } as const;
  return record.purpose === 'claim_evidence'
    ? computeEngineProofRecordId({
        ...common,
        purpose: record.purpose,
        claimIdentityHash: record.claimIdentityHash,
        subject: record.subject,
      })
    : computeEngineProofRecordId({
        ...common,
        purpose: record.purpose,
        claimIdentityHash: record.claimIdentityHash,
        subject: record.subject,
      });
}

export function findingEvidenceRecordIdentityViolation(
  record: FindingEvidenceRecord,
): string | undefined {
  const canonicalId = computeFindingEvidenceRecordId(record);
  if (record.evidenceId !== canonicalId) {
    return `Evidence record "${record.evidenceId}" does not match its canonical content address "${canonicalId}"`;
  }
  if (record.kind === 'engine_proof' && record.proofId !== canonicalId) {
    return `Engine proof "${record.proofId}" must equal its canonical evidenceId "${canonicalId}"`;
  }
  return undefined;
}

export function evidenceRecordMatchesRawEvidence(
  record: FindingEvidenceRecord,
  evidence: RawFindingEvidence,
): boolean {
  if (record.kind !== evidence.kind) {
    return false;
  }
  if (record.kind === 'engine_proof') {
    return evidence.kind === 'engine_proof'
      && evidence.proofId === record.proofId;
  }
  return evidence.kind === 'file_quote'
    && evidence.path === record.path
    && evidence.startLine === record.startLine
    && evidence.endLine === record.endLine
    && evidence.verbatimExcerpt === record.verbatimExcerpt
    && evidence.snapshotId === record.snapshotId;
}
