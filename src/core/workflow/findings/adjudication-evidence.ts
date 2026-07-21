import { createHash } from 'node:crypto';
import { loadTemplate } from '../../../shared/prompts/index.js';
import {
  renderFencedJsonBlock,
  renderFencedTextBlock,
} from '../instruction/fenced-block.js';
import type { ReviewScopeSnapshot, ReviewScopeUntrackedEvidence } from './snapshot.js';
import type {
  FindingConflictAdjudicationAttempt,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  RawFinding,
} from './types.js';

interface AdjudicationConflictEvidence {
  id: string;
  status: FindingLedgerConflict['status'];
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
  firstSeen: FindingLedgerConflict['firstSeen'];
  lastSeen: FindingLedgerConflict['lastSeen'];
}

export interface AdjudicationEvidenceSnapshot {
  conflict: AdjudicationConflictEvidence;
  findings: FindingLedgerEntry[];
  rawFindings: RawFinding[];
  reviewScopeSnapshotId: string;
  trackedDiffDigest: string;
  untrackedEvidence: ReviewScopeUntrackedEvidence[];
}

function selectLedgerEvidence(
  ledger: FindingLedger,
  conflict: FindingLedgerConflict,
): Pick<AdjudicationEvidenceSnapshot, 'conflict' | 'findings' | 'rawFindings'> {
  const findingsById = new Map(ledger.findings.map((finding) => [finding.id, finding]));
  const findings = conflict.findingIds
    .map((findingId) => findingsById.get(findingId))
    .filter((finding): finding is FindingLedgerEntry => finding !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const rawFindingIds = new Set([
    ...conflict.rawFindingIds,
    ...findings.flatMap((finding) => finding.rawFindingIds),
  ]);
  const rawFindingsById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const rawFindings = [...rawFindingIds]
    .map((rawFindingId) => rawFindingsById.get(rawFindingId))
    .filter((raw): raw is RawFinding => raw !== undefined)
    .sort((left, right) => left.rawFindingId.localeCompare(right.rawFindingId));
  return structuredClone({
    conflict: {
      id: conflict.id,
      status: conflict.status,
      findingIds: [...conflict.findingIds].sort(),
      rawFindingIds: [...conflict.rawFindingIds].sort(),
      description: conflict.description,
      firstSeen: conflict.firstSeen,
      lastSeen: conflict.lastSeen,
    },
    findings,
    rawFindings,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 'null'
        : canonicalJson(item)
    )).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Adjudication evidence contains a non-serializable value');
  }
  return serialized;
}

export function computeAdjudicationEvidenceHash(
  snapshot: Pick<AdjudicationEvidenceSnapshot, 'conflict' | 'findings' | 'rawFindings' | 'reviewScopeSnapshotId'>,
): string {
  return createHash('sha256').update(canonicalJson({
    conflict: snapshot.conflict,
    findings: snapshot.findings,
    rawFindings: snapshot.rawFindings,
    reviewScopeSnapshotId: snapshot.reviewScopeSnapshotId,
  })).digest('hex');
}

export function computeConflictEvidenceHash(
  conflict: FindingLedgerConflict,
  ledger: FindingLedger,
  reviewScopeSnapshotId: string,
): string {
  return computeAdjudicationEvidenceHash({
    ...selectLedgerEvidence(ledger, conflict),
    reviewScopeSnapshotId,
  });
}

export function buildAdjudicationEvidenceSnapshot(input: {
  ledger: FindingLedger;
  conflictId: string;
  reviewScopeSnapshot: ReviewScopeSnapshot;
}): AdjudicationEvidenceSnapshot {
  const conflict = input.ledger.conflicts.find((candidate) => candidate.id === input.conflictId);
  if (conflict === undefined) {
    throw new Error(`Finding conflict "${input.conflictId}" disappeared before evidence collection`);
  }
  const ledgerEvidence = selectLedgerEvidence(input.ledger, conflict);
  return {
    ...ledgerEvidence,
    reviewScopeSnapshotId: input.reviewScopeSnapshot.reviewScopeSnapshotId,
    trackedDiffDigest: createHash('sha256')
      .update(input.reviewScopeSnapshot.trackedDiff ?? '')
      .digest('hex'),
    untrackedEvidence: input.reviewScopeSnapshot.untrackedEvidence.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.contentDigest === undefined ? {} : { contentDigest: entry.contentDigest }),
    })),
  };
}

function renderUntrackedEvidence(entries: ReviewScopeUntrackedEvidence[]): string {
  if (entries.length === 0) {
    return '(no untracked files)';
  }
  return entries.map((entry) => {
    const header = `untracked: ${entry.path} (${entry.kind})`;
    if (entry.contentDigest === undefined) {
      return header;
    }
    return `${header}\ncontentDigest: ${entry.contentDigest}`;
  }).join('\n\n');
}

export function renderAdjudicationInstruction(snapshot: AdjudicationEvidenceSnapshot): string {
  const disputes = snapshot.findings.flatMap((finding) => (finding.disputes ?? []).map((dispute) => ({
    findingId: finding.id,
    ...dispute,
  })));
  return loadTemplate('finding_conflict_adjudication_instruction', 'en', {
    conflictId: snapshot.conflict.id,
    conflictBlock: renderFencedJsonBlock(snapshot.conflict),
    findingsBlock: snapshot.findings.length > 0
      ? renderFencedJsonBlock(snapshot.findings)
      : renderFencedTextBlock('(no ledger finding matched this conflict\'s findingIds)'),
    rawFindingsBlock: snapshot.rawFindings.length > 0
      ? renderFencedJsonBlock(snapshot.rawFindings)
      : renderFencedTextBlock('(no raw findings on record for this conflict)'),
    disputesBlock: disputes.length > 0
      ? renderFencedJsonBlock(disputes)
      : renderFencedTextBlock('(no disputes recorded on the finding(s) above)'),
    diffBlock: renderFencedTextBlock([
      `reviewScopeSnapshotId: ${snapshot.reviewScopeSnapshotId}`,
      `trackedDiffDigest: ${snapshot.trackedDiffDigest}`,
      renderUntrackedEvidence(snapshot.untrackedEvidence),
    ].join('\n')),
  });
}

export function isConflictUnadjudicated(
  conflict: Pick<FindingLedgerConflict, 'adjudications' | 'adjudicationAttempts'>,
  currentEvidenceHash: string,
): boolean {
  const seen = (conflict.adjudications ?? []).some((record) => record.evidenceHash === currentEvidenceHash)
    || (conflict.adjudicationAttempts ?? []).some((attempt) => attempt.evidenceHash === currentEvidenceHash);
  return !seen;
}

export function isLedgerConflictUnadjudicated(
  conflict: FindingLedgerConflict,
  ledger: FindingLedger,
  reviewScopeSnapshotId: string,
): boolean {
  return isConflictUnadjudicated(
    conflict,
    computeConflictEvidenceHash(conflict, ledger, reviewScopeSnapshotId),
  );
}

export function findReusablePendingAttempt(
  conflict: Pick<FindingLedgerConflict, 'adjudications' | 'adjudicationAttempts'>,
  currentEvidenceHash: string,
  runId: string,
): FindingConflictAdjudicationAttempt | undefined {
  const completed = (conflict.adjudications ?? []).some((record) => record.evidenceHash === currentEvidenceHash);
  if (completed) {
    return undefined;
  }
  return (conflict.adjudicationAttempts ?? []).find((attempt) => (
    attempt.evidenceHash === currentEvidenceHash && attempt.startedAt.runId === runId
  ));
}
