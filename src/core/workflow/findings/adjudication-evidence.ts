import { createHash } from 'node:crypto';
import { loadTemplate } from '../../../shared/prompts/index.js';
import {
  renderFencedJsonBlock,
  renderFencedTextBlock,
} from '../instruction/fenced-block.js';
import type { ReviewScopeSnapshot, ReviewScopeUntrackedEvidence } from './snapshot.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  RawFinding,
} from './types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';

interface AdjudicationConflictEvidence {
  id: string;
  status: FindingLedgerConflict['status'];
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
  firstSeen: FindingLedgerConflict['firstSeen'];
  lastSeen: FindingLedgerConflict['lastSeen'];
}

type AdjudicationFindingEvidence = Omit<FindingLedgerEntry, 'revision'>;

function snapshotFinding(finding: FindingLedgerEntry): AdjudicationFindingEvidence {
  return structuredClone({
    id: finding.id,
    status: finding.status,
    lifecycle: finding.lifecycle,
    severity: finding.severity,
    title: finding.title,
    evidenceIds: [...finding.evidenceIds],
    ...(finding.description !== undefined ? { description: finding.description } : {}),
    ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
    reviewers: [...finding.reviewers].sort(compareBinaryStrings),
    rawFindingIds: [...finding.rawFindingIds].sort(compareBinaryStrings),
    firstSeen: { ...finding.firstSeen },
    lastSeen: { ...finding.lastSeen },
    ...(finding.resolvedAt !== undefined ? { resolvedAt: finding.resolvedAt } : {}),
    ...(finding.resolvedEvidence !== undefined ? { resolvedEvidence: finding.resolvedEvidence } : {}),
    ...(finding.reopenedEvidence !== undefined ? { reopenedEvidence: finding.reopenedEvidence } : {}),
    ...(finding.waivers !== undefined ? { waivers: finding.waivers } : {}),
    ...(finding.disputes !== undefined ? { disputes: finding.disputes } : {}),
    ...(finding.invalidatedAt !== undefined ? { invalidatedAt: finding.invalidatedAt } : {}),
    ...(finding.invalidatedEvidence !== undefined
      ? { invalidatedEvidence: finding.invalidatedEvidence }
      : {}),
    ...(finding.supersededByFindingId !== undefined
      ? { supersededByFindingId: finding.supersededByFindingId }
      : {}),
    ...(finding.dismissal !== undefined ? { dismissal: finding.dismissal } : {}),
    ...(finding.provisional !== undefined ? { provisional: finding.provisional } : {}),
    ...(finding.rejectedObservations !== undefined
      ? { rejectedObservations: finding.rejectedObservations }
      : {}),
  });
}

function snapshotRawFinding(rawFinding: RawFinding): RawFinding {
  return structuredClone({
    rawFindingId: rawFinding.rawFindingId,
    stepName: rawFinding.stepName,
    reviewer: rawFinding.reviewer,
    familyTag: rawFinding.familyTag,
    severity: rawFinding.severity,
    title: rawFinding.title,
    description: rawFinding.description,
    suggestion: rawFinding.suggestion,
    relation: rawFinding.relation,
    targetFindingId: rawFinding.targetFindingId,
    ...(rawFinding.targetPrecondition !== undefined
      ? { targetPrecondition: rawFinding.targetPrecondition }
      : {}),
    evidence: rawFinding.evidence,
  });
}

export interface AdjudicationEvidenceSnapshot {
  conflict: AdjudicationConflictEvidence;
  findings: AdjudicationFindingEvidence[];
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
    .map(snapshotFinding)
    .sort((left, right) => compareBinaryStrings(left.id, right.id));
  const rawFindingIds = new Set([
    ...conflict.rawFindingIds,
    ...findings.flatMap((finding) => finding.rawFindingIds),
  ]);
  const rawFindingsById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const rawFindings = [...rawFindingIds]
    .map((rawFindingId) => rawFindingsById.get(rawFindingId))
    .filter((raw): raw is RawFinding => raw !== undefined)
    .sort((left, right) => compareBinaryStrings(left.rawFindingId, right.rawFindingId));
  return {
    conflict: {
      id: conflict.id,
      status: conflict.status,
      findingIds: [...conflict.findingIds].sort(compareBinaryStrings),
      rawFindingIds: [...conflict.rawFindingIds].sort(compareBinaryStrings),
      description: conflict.description,
      firstSeen: { ...conflict.firstSeen },
      lastSeen: { ...conflict.lastSeen },
    },
    findings,
    rawFindings: rawFindings.map(snapshotRawFinding),
  };
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
  conflict: Pick<FindingLedgerConflict, 'adjudications'>,
  currentEvidenceHash: string,
): boolean {
  const seen = (conflict.adjudications ?? []).some(
    (record) => record.evidenceHash === currentEvidenceHash,
  );
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
