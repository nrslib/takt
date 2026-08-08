import { createHash } from 'node:crypto';
import { loadTemplate } from '../../../shared/prompts/index.js';
import {
  renderFencedJsonBlock,
  renderFencedTextBlock,
} from '../instruction/fenced-block.js';
import type { ReviewScopeSnapshot, ReviewScopeUntrackedEvidence } from './snapshot.js';
import type { ConflictAdjudicationSnapshot } from '../../models/finding-contract-types.js';
import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingObservation,
  RawFinding,
} from './types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  renderFindingEvidenceSearchWindows,
  type FindingEvidenceSearchWindow,
} from './evidence-search.js';

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
    target: finding.target,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
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
    target: rawFinding.target,
    targetIdentityHash: rawFinding.targetIdentityHash,
    claimIdentityHash: rawFinding.claimIdentityHash,
    semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
    candidateIdentityHash: rawFinding.candidateIdentityHash,
    sourceBinding: rawFinding.sourceBinding,
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

interface ConflictAdjudicationSubjectReference {
  subjectId: string;
  role: ConflictAdjudicationSnapshot['subjects'][number]['role'];
  findingId: string;
  expectedHead: ConflictAdjudicationSnapshot['subjects'][number]['expectedHead'];
  targetIdentityHash: string | null;
  claimIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
  claimSnapshotDigest: string;
  evidenceSetDigest: string;
  sourceRawFindingIds: string[];
  sourceRawFindingCount: number;
  sourceRawFindingDigest: string;
  sourceRawPayloadDigest: string;
  sourceRawPayloadDigests: string[];
  evidenceBindingIds: string[];
  evidenceBindingCount: number;
  evidenceBindingDigest: string;
  rawClaimLandingIds: string[];
  rawClaimLandingCount: number;
  rawClaimLandingDigest: string;
}

interface ConflictAdjudicationSnapshotReference {
  snapshotFormat: 'reference-v1';
  conflictSnapshotId: string;
  conflictId: string;
  expectedConflictHead: ConflictAdjudicationSnapshot['expectedConflictHead'];
  claimUniverseDigest: string;
  coverageSnapshotDigest: string;
  evidenceSnapshotDigest: string;
  targetContentDigests: ConflictAdjudicationSnapshot['targetContentDigests'];
  rawClaimLandingIds: string[];
  rawClaimLandingCount: number;
  rawClaimLandingDigest: string;
  priorSettlementIds: string[];
  priorSettlementCount: number;
  priorSettlementDigest: string;
  subjects: ConflictAdjudicationSubjectReference[];
  originStep: string | null;
}

const INLINE_HISTORY_LIMIT = 3;

export interface ConflictAdjudicationHistoryOrder {
  sourceRawFindingIds: ReadonlyMap<string, FindingObservation>;
  sourceRawPayloadDigests: ReadonlyMap<string, FindingObservation>;
  evidenceBindingIds: ReadonlyMap<string, FindingObservation>;
  rawClaimLandingIds: ReadonlyMap<string, FindingObservation>;
  priorSettlementIds: ReadonlyMap<string, FindingObservation>;
}

function rememberLatestObservation(
  observations: Map<string, FindingObservation>,
  key: string,
  observation: FindingObservation,
): void {
  const current = observations.get(key);
  if (
    current === undefined
    || compareObservations(current, observation) < 0
  ) {
    observations.set(key, structuredClone(observation));
  }
}

export function buildConflictAdjudicationHistoryOrder(
  ledger: FindingLedger,
): ConflictAdjudicationHistoryOrder {
  const sourceRawFindingIds = new Map<string, FindingObservation>();
  const sourceRawPayloadDigests = new Map<string, FindingObservation>();
  for (const snapshot of ledger.rawCanonicalSnapshots) {
    rememberLatestObservation(sourceRawFindingIds, snapshot.rawFindingId, snapshot.capturedAt);
    rememberLatestObservation(sourceRawPayloadDigests, snapshot.rawPayloadDigest, snapshot.capturedAt);
  }
  const evidenceBindingIds = new Map<string, FindingObservation>();
  for (const event of ledger.lifecycleEvents) {
    for (const bindingId of event.evidenceBindingIds) {
      rememberLatestObservation(evidenceBindingIds, bindingId, event.occurredAt);
    }
  }
  const rawClaimLandingIds = new Map<string, FindingObservation>();
  for (const landing of ledger.conflictRawClaimLandings) {
    rememberLatestObservation(rawClaimLandingIds, landing.rawClaimLandingId, landing.landedAt);
  }
  const priorSettlementIds = new Map<string, FindingObservation>();
  for (const settlement of ledger.conflictClaimSettlements) {
    rememberLatestObservation(priorSettlementIds, settlement.settlementId, settlement.recordedAt);
  }
  return {
    sourceRawFindingIds,
    sourceRawPayloadDigests,
    evidenceBindingIds,
    rawClaimLandingIds,
    priorSettlementIds,
  };
}

function compareObservations(left: FindingObservation, right: FindingObservation): number {
  return compareBinaryStrings(left.timestamp, right.timestamp)
    || compareBinaryStrings(left.runId, right.runId)
    || compareBinaryStrings(left.stepName, right.stepName);
}

function inlineHistory(
  values: readonly string[],
  observedAtByValue: ReadonlyMap<string, FindingObservation>,
): string[] {
  const ordered = [...values].sort((left, right) => {
    const leftObservedAt = observedAtByValue.get(left);
    const rightObservedAt = observedAtByValue.get(right);
    if (leftObservedAt === undefined || rightObservedAt === undefined) {
      throw new Error(`Conflict adjudication history is missing an observation for ${leftObservedAt === undefined ? left : right}`);
    }
    return compareObservations(leftObservedAt, rightObservedAt)
      || compareBinaryStrings(left, right);
  });
  return ordered.slice(-INLINE_HISTORY_LIMIT);
}

function digestStringSet(values: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalJson([...values].sort(compareBinaryStrings)))
    .digest('hex');
}

function subjectReference(
  subject: ConflictAdjudicationSnapshot['subjects'][number],
  history: ConflictAdjudicationHistoryOrder,
): ConflictAdjudicationSubjectReference {
  return {
    subjectId: subject.subjectId,
    role: subject.role,
    findingId: subject.findingId,
    expectedHead: structuredClone(subject.expectedHead),
    targetIdentityHash: subject.targetIdentityHash,
    claimIdentityHash: subject.claimIdentityHash,
    semanticClaimIdentityHash: subject.semanticClaimIdentityHash,
    claimSnapshotDigest: subject.claimSnapshotDigest,
    evidenceSetDigest: subject.evidenceSetDigest,
    sourceRawFindingIds: inlineHistory(subject.sourceRawFindingIds, history.sourceRawFindingIds),
    sourceRawFindingCount: subject.sourceRawFindingIds.length,
    sourceRawFindingDigest: digestStringSet(subject.sourceRawFindingIds),
    sourceRawPayloadDigest: digestStringSet(subject.sourceRawPayloadDigests),
    sourceRawPayloadDigests: inlineHistory(subject.sourceRawPayloadDigests, history.sourceRawPayloadDigests),
    evidenceBindingIds: inlineHistory(subject.evidenceBindingIds, history.evidenceBindingIds),
    evidenceBindingCount: subject.evidenceBindingIds.length,
    evidenceBindingDigest: digestStringSet(subject.evidenceBindingIds),
    rawClaimLandingIds: inlineHistory(subject.rawClaimLandingIds, history.rawClaimLandingIds),
    rawClaimLandingCount: subject.rawClaimLandingIds.length,
    rawClaimLandingDigest: digestStringSet(subject.rawClaimLandingIds),
  };
}

/**
 * Durable snapshot は台帳側の完全な入力を保持するが、provider には履歴全体を再送しない。
 * 直近の少数参照と、それ以前を表す count/digest を渡し、完全な snapshot は engine が解決する。
 */
export function buildConflictAdjudicationSnapshotReference(
  snapshot: ConflictAdjudicationSnapshot,
  history: ConflictAdjudicationHistoryOrder,
): ConflictAdjudicationSnapshotReference {
  return {
    snapshotFormat: 'reference-v1',
    conflictSnapshotId: snapshot.conflictSnapshotId,
    conflictId: snapshot.conflictId,
    expectedConflictHead: structuredClone(snapshot.expectedConflictHead),
    claimUniverseDigest: snapshot.claimUniverseDigest,
    coverageSnapshotDigest: snapshot.coverageSnapshotDigest,
    evidenceSnapshotDigest: snapshot.evidenceSnapshotDigest,
    targetContentDigests: snapshot.targetContentDigests ?? [],
    rawClaimLandingIds: inlineHistory(snapshot.rawClaimLandingIds, history.rawClaimLandingIds),
    rawClaimLandingCount: snapshot.rawClaimLandingIds.length,
    rawClaimLandingDigest: digestStringSet(snapshot.rawClaimLandingIds),
    priorSettlementIds: inlineHistory(snapshot.priorSettlementIds, history.priorSettlementIds),
    priorSettlementCount: snapshot.priorSettlementIds.length,
    priorSettlementDigest: digestStringSet(snapshot.priorSettlementIds),
    subjects: snapshot.subjects.map((subject) => subjectReference(subject, history)),
    originStep: snapshot.originStep,
  };
}

export function renderConflictAdjudicationInstruction(
  snapshot: ConflictAdjudicationSnapshot,
  history: ConflictAdjudicationHistoryOrder,
  grounding?: {
    reviewScopeSnapshotId: string;
    windows: readonly FindingEvidenceSearchWindow[];
  },
): string {
  const instruction = [
    'Adjudicate the durable finding conflict snapshot below. You are read-only.',
    'Return exactly one configured proposal. References must use subjectId values from the snapshot and authorityRefIds must identify exact engine-proof records.',
    'Use merge_holding only for a verified identical claim, promote_holding only with verification supporting the complete product projection, terminate_subject only with verification supporting no-issue or refutation, and undetermined otherwise.',
    'The snapshot below is an engine-owned reference. Historical ID collections retain a recent reference window and use count/digest for older members; do not infer omitted members.',
    '',
    '## Durable conflict snapshot',
    renderFencedJsonBlock(buildConflictAdjudicationSnapshotReference(snapshot, history)),
  ];
  if (grounding === undefined) {
    return instruction.join('\n');
  }
  return [
    ...instruction,
    '',
    '## Engine-provided target snapshot windows',
    `reviewScopeSnapshotId: ${grounding.reviewScopeSnapshotId}`,
    'Use these immutable windows to verify the disputed target. Do not read the live working tree or infer content outside the supplied windows.',
    grounding.windows.length === 0
      ? '(target files are unavailable in the supplied snapshot; verification is undetermined and the proposal must not infer source content)'
      : renderFindingEvidenceSearchWindows(grounding.windows),
  ].join('\n');
}
