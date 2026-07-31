import { createHash } from 'node:crypto';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { computeRawFindingIntegrityDigest } from './finding-raw-integrity.js';
import type {
  FindingLedgerEntry,
  FindingMutationPrecondition,
  RawFinding,
} from './finding-types.js';

const EVIDENCE_HASH_ALGORITHM_VERSION = 2;

export function findingRevision(
  entry: Pick<FindingLedgerEntry, 'revision'>,
): number {
  return entry.revision;
}

export function computeFindingEvidenceHash(
  entry: FindingLedgerEntry,
  rawFindingsById: ReadonlyMap<string, RawFinding>,
): string {
  const rawFindingIds = [...entry.rawFindingIds].sort(compareBinaryStrings);
  const rawEvidenceHashes = rawFindingIds.map((rawFindingId) => {
    const raw = rawFindingsById.get(rawFindingId);
    return raw === undefined
      ? `missing:${rawFindingId}`
      : computeRawFindingIntegrityDigest(raw);
  });
  const payload = JSON.stringify([
    EVIDENCE_HASH_ALGORITHM_VERSION,
    entry.id,
    entry.status,
    entry.lifecycle,
    entry.severity,
    entry.title,
    [...entry.evidenceIds].sort(compareBinaryStrings),
    entry.description ?? '',
    entry.suggestion ?? '',
    rawFindingIds,
    rawEvidenceHashes,
    entry.disputes ?? [],
    entry.waivers ?? [],
    entry.supersededByFindingId ?? '',
    findingRevision(entry),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export function captureFindingMutationPrecondition(
  ledger: {
    findings: readonly FindingLedgerEntry[];
    rawFindings: readonly RawFinding[];
  },
  targetFindingId: string,
): FindingMutationPrecondition | undefined {
  const entry = ledger.findings.find(
    (finding) => finding.id === targetFindingId,
  );
  if (entry === undefined) {
    return undefined;
  }
  const rawFindingsById = new Map(
    ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]),
  );
  return {
    targetFindingId: entry.id,
    targetRevision: findingRevision(entry),
    targetStatus: entry.status,
    targetEvidenceHash: computeFindingEvidenceHash(entry, rawFindingsById),
  };
}

export function sameFindingMutationPrecondition(
  left: FindingMutationPrecondition,
  right: FindingMutationPrecondition,
): boolean {
  return left.targetFindingId === right.targetFindingId
    && left.targetRevision === right.targetRevision
    && left.targetStatus === right.targetStatus
    && left.targetEvidenceHash === right.targetEvidenceHash;
}

export function findingMatchesMutationPrecondition(
  ledger: {
    findings: readonly FindingLedgerEntry[];
    rawFindings: readonly RawFinding[];
  },
  precondition: FindingMutationPrecondition,
): boolean {
  const current = captureFindingMutationPrecondition(
    ledger,
    precondition.targetFindingId,
  );
  return current !== undefined
    && sameFindingMutationPrecondition(current, precondition);
}
