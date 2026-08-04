import { posix } from 'node:path';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  FileQuoteEvidence,
  FindingLedger,
  FindingLedgerEntry,
  RawFinding,
  RawFindingEvidence,
} from './types.js';

export interface EvidenceFileLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

function normalizedEvidenceLocation(
  evidence: FileQuoteEvidence,
): EvidenceFileLocation {
  return {
    path: posix.normalize(evidence.path.trim()),
    startLine: evidence.startLine,
    endLine: evidence.endLine,
  };
}

function normalizedLocationSet(
  evidence: readonly FileQuoteEvidence[],
): EvidenceFileLocation[] {
  const byIdentity = new Map<string, EvidenceFileLocation>();
  for (const quote of evidence) {
    const normalized = normalizedEvidenceLocation(quote);
    const identity = JSON.stringify([
      normalized.path,
      normalized.startLine,
      normalized.endLine,
    ]);
    byIdentity.set(identity, normalized);
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([, location]) => location);
}

export function formatFileQuoteLocation(evidence: EvidenceFileLocation): string {
  return evidence.startLine === evidence.endLine
    ? `${evidence.path}:${evidence.startLine}`
    : `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
}

export function rawFindingFileQuoteLocations(
  raw: Pick<RawFinding, 'evidence'>,
): EvidenceFileLocation[] {
  return normalizedLocationSet(
    raw.evidence.filter((evidence): evidence is FileQuoteEvidence => (
      evidence.kind === 'file_quote'
    )),
  );
}

export function rawEvidenceFileQuoteLocations(
  evidence: readonly RawFindingEvidence[],
): EvidenceFileLocation[] {
  return normalizedLocationSet(
    evidence.filter((item): item is FileQuoteEvidence => item.kind === 'file_quote'),
  );
}

export function findingFileQuoteLocations(
  ledger: Pick<FindingLedger, 'evidenceRecords'>,
  finding: Pick<FindingLedgerEntry, 'evidenceIds'>,
): EvidenceFileLocation[] {
  const evidenceById = new Map(
    ledger.evidenceRecords.map((record) => [record.evidenceId, record]),
  );
  const records: FileQuoteEvidence[] = [];
  for (const evidenceId of finding.evidenceIds) {
    const record = evidenceById.get(evidenceId);
    if (record?.kind === 'file_quote') records.push(record);
  }
  return normalizedLocationSet(records);
}

/** Analytics/UI projection 専用。agent、identity、invalidation での利用は禁止。 */
export function findingAnalyticsDisplayLocation(
  ledger: Pick<FindingLedger, 'evidenceRecords'>,
  finding: Pick<FindingLedgerEntry, 'evidenceIds'>,
): string | undefined {
  const location = findingFileQuoteLocations(ledger, finding)[0];
  return location === undefined ? undefined : formatFileQuoteLocation(location);
}
