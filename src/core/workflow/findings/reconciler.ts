import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingManagerOutput,
  FindingObservation,
  FindingProvisionalKind,
  FindingProvisionalMetadata,
  FindingReconcileContext,
  FindingRecord,
  FindingSeverity,
  RawFindingDisposition,
  RawFinding,
} from './types.js';
import { RAW_FINDING_DISPOSITION_OUTCOMES } from './types.js';
import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import {
  validateFindingManagerOutput,
  validateManagerActionRecoveryOutput,
} from './manager-output-validation.js';
import { countInterpretationEpochs } from './interpretation-wal.js';
import { formatConflictId } from '../../models/finding-conflict-identity.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';

/**
 * provisional finding の upsert 指示。stableKey が同じ
 * open provisional が既にあれば同一 ID を更新し（新しい finding ID を作らない —
 * 再発同定キー）、無ければ新規 open finding を provisional メタデータ付きで作る。
 */
export interface ProvisionalFindingSpec {
  kind: FindingProvisionalKind;
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  reason: string;
  title: string;
  /** raw 由来なら元 severity、system overflow / budget failure は 'high'。 */
  severity: FindingSeverity;
  location?: string;
  description?: string;
  suggestion?: string;
  reviewers: string[];
  recoveryReviewerStableKey?: string;
  actionRecovery?: FindingProvisionalMetadata['actionRecovery'];
}

interface ReconcileFindingLedgerInput {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  context: FindingReconcileContext;
  priorStepResponseText?: string;
  provisionalFindings: ProvisionalFindingSpec[];
  rawFindingDispositions: readonly RawFindingDisposition[];
  rawProvenanceByRawFindingId: ReadonlyMap<string, { reviewerStableKey: string; lineageKey: string }>;
}

function formatFindingId(nextId: number): string {
  return `F-${String(nextId).padStart(4, '0')}`;
}

function assertKnownFinding(findingIds: Set<string>, findingId: string): void {
  if (!findingIds.has(findingId)) {
    throw new Error(`Unknown finding id "${findingId}"`);
  }
}

function assertKnownConflict(conflictsById: ReadonlyMap<string, FindingLedgerConflict>, conflictId: string): void {
  if (!conflictsById.has(conflictId)) {
    throw new Error(`Unknown conflict id "${conflictId}"`);
  }
}

function assertKnownRawFindings(rawFindingIds: Set<string>, referencedIds: readonly string[]): void {
  if (referencedIds.length === 0) {
    throw new Error('Manager output must reference at least one raw finding id');
  }
  assertUniqueIds(referencedIds, 'raw finding id');
  for (const rawFindingId of referencedIds) {
    if (!rawFindingIds.has(rawFindingId)) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${label} "${id}"`);
    }
    seen.add(id);
  }
}

function assertFindingStatus(finding: FindingRecord, expectedStatus: FindingRecord['status'], action: string): void {
  if (finding.status !== expectedStatus) {
    throw new Error(`Cannot ${action} finding "${finding.id}" because it is not ${expectedStatus}`);
  }
}

function markRawFindingIdsUsed(usedRawFindingIds: Set<string>, rawFindingIds: readonly string[]): void {
  for (const rawFindingId of rawFindingIds) {
    if (usedRawFindingIds.has(rawFindingId)) {
      throw new Error(`Raw finding id "${rawFindingId}" is referenced by multiple manager decisions`);
    }
    usedRawFindingIds.add(rawFindingId);
  }
}

function assertNonEmptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) {
    throw new Error(`Manager output must reference at least one ${label}`);
  }
}

function mergeRawFindingIds(current: readonly string[], next: readonly string[]): string[] {
  return Array.from(new Set([...current, ...next]));
}

function bumpRevision(finding: Pick<FindingRecord, 'revision'>): number {
  return finding.revision + 1;
}

function mergeReviewers(current: readonly string[], rawFindings: readonly RawFinding[]): string[] {
  return Array.from(new Set([...current, ...rawFindings.map((finding) => finding.reviewer)]));
}

function mergeRawFindingDetails(current: readonly RawFinding[], next: readonly RawFinding[]): RawFinding[] {
  const byId = new Map<string, RawFinding>();
  for (const rawFinding of current) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  for (const rawFinding of next) {
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  return [...byId.values()];
}

function assertResolvedEvidenceRawFindings(input: {
  finding: FindingRecord;
  resolvedRawFindingIds: readonly string[];
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
  currentRawFindingsById: ReadonlyMap<string, RawFinding>;
}): void {
  let hasCurrentConfirmation = false;
  for (const rawFindingId of input.resolvedRawFindingIds) {
    const currentRawFinding = input.currentRawFindingsById.get(rawFindingId);
    if (currentRawFinding !== undefined) {
      if (currentRawFinding.relation !== 'resolution_confirmation') {
        throw new Error(
          `Resolved finding "${input.finding.id}" references current raw finding "${rawFindingId}" that is not a resolution_confirmation`,
        );
      }
      if (currentRawFinding.targetFindingId !== input.finding.id) {
        throw new Error(
          `Resolution confirmation "${rawFindingId}" targets "${currentRawFinding.targetFindingId ?? '(none)'}" but was cited for "${input.finding.id}"`,
        );
      }
      hasCurrentConfirmation = true;
      continue;
    }
    if (!input.finding.rawFindingIds.includes(rawFindingId)) {
      throw new Error(`Unknown raw finding id "${rawFindingId}"`);
    }
    if (input.previousRawFindingsById.get(rawFindingId) === undefined) {
      throw new Error(
        `Resolved finding "${input.finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`,
      );
    }
  }
  // 解消には現在ラウンドの解消確認が必須（レビュアーの沈黙では解消させない）。
  if (!hasCurrentConfirmation) {
    throw new Error(
      `Resolved finding "${input.finding.id}" requires at least one current resolution_confirmation raw finding targeting it`,
    );
  }
}

function getRawFinding(rawFindings: readonly RawFinding[], rawFindingIds: readonly string[]): RawFinding {
  const rawFinding = rawFindings.find((finding) => rawFindingIds.includes(finding.rawFindingId));
  if (rawFinding === undefined) {
    throw new Error(`Raw finding ids were validated but not found: ${rawFindingIds.join(', ')}`);
  }
  return rawFinding;
}

function getRawFindings(rawFindings: readonly RawFinding[], rawFindingIds: readonly string[]): RawFinding[] {
  return rawFindingIds.map((rawFindingId) => {
    const rawFinding = rawFindings.find((finding) => finding.rawFindingId === rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(`Raw finding id was validated but not found: ${rawFindingId}`);
    }
    return rawFinding;
  });
}

function rawEvidenceFields(rawFindings: readonly RawFinding[]): Pick<FindingRecord, 'location' | 'description' | 'suggestion' | 'reviewers'> {
  const primary = rawFindings[0];
  if (primary === undefined) {
    throw new Error('At least one raw finding is required to build finding evidence');
  }
  return {
    ...(primary.location !== undefined ? { location: primary.location } : {}),
    description: primary.description,
    ...(primary.suggestion !== undefined ? { suggestion: primary.suggestion } : {}),
    reviewers: Array.from(new Set(rawFindings.map((finding) => finding.reviewer))),
  };
}

function buildNewFinding(input: {
  id: string;
  rawFindingIds: string[];
  title: string;
  severity: FindingRecord['severity'];
  rawFindings: RawFinding[];
  firstSeenStepName: string;
  context: FindingReconcileContext;
}): FindingRecord {
  const observation = {
    runId: input.context.runId,
    stepName: input.firstSeenStepName,
    timestamp: input.context.timestamp,
  };
  return {
    id: input.id,
    status: 'open',
    lifecycle: 'new',
    severity: input.severity,
    title: input.title,
    ...rawEvidenceFields(input.rawFindings),
    rawFindingIds: input.rawFindingIds,
    firstSeen: observation,
    lastSeen: observationFromContext(input.context),
    revision: 1,
  };
}

function observationFromContext(context: FindingReconcileContext): FindingObservation {
  return {
    stepName: context.stepName,
    runId: context.runId,
    timestamp: context.timestamp,
  };
}

function withoutResolutionFields(finding: FindingRecord): Omit<FindingRecord, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: finding.id,
    status: finding.status,
    lifecycle: finding.lifecycle,
    severity: finding.severity,
    title: finding.title,
    rawFindingIds: finding.rawFindingIds,
    ...(finding.location !== undefined ? { location: finding.location } : {}),
    ...(finding.waivers !== undefined ? { waivers: finding.waivers } : {}),
    ...(finding.disputes !== undefined ? { disputes: finding.disputes } : {}),
    ...(finding.description !== undefined ? { description: finding.description } : {}),
    ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
    reviewers: finding.reviewers,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
    ...(finding.reopenedEvidence !== undefined ? { reopenedEvidence: finding.reopenedEvidence } : {}),
    revision: finding.revision,
    ...(finding.provisional !== undefined ? { provisional: finding.provisional } : {}),
    ...(finding.dismissal !== undefined ? { dismissal: finding.dismissal } : {}),
    // rejectedObservations の監査添付履歴も解消情報ではないため保持する。
    ...(finding.rejectedObservations !== undefined ? { rejectedObservations: finding.rejectedObservations } : {}),
  };
}

function withoutConflictResolutionFields(
  conflict: FindingLedgerConflict,
): Omit<FindingLedgerConflict, 'resolvedAt' | 'resolvedEvidence'> {
  return {
    id: conflict.id,
    status: conflict.status,
    findingIds: conflict.findingIds,
    rawFindingIds: conflict.rawFindingIds,
    description: conflict.description,
    firstSeen: conflict.firstSeen,
    lastSeen: conflict.lastSeen,
    ...(conflict.adjudications !== undefined ? { adjudications: conflict.adjudications } : {}),
    ...(conflict.adjudicationAttempts !== undefined
      ? { adjudicationAttempts: conflict.adjudicationAttempts }
      : {}),
  };
}

function reconcileLedgerConflicts(input: {
  previousLedger: FindingLedger;
  managerOutput: FindingManagerOutput;
  knownFindingIds: Set<string>;
  rawFindingIds: Set<string>;
  usedRawFindingIds: Set<string>;
  context: FindingReconcileContext;
}): FindingLedgerConflict[] {
  const conflictsById = new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, { ...conflict }]));

  for (const resolvedConflict of input.managerOutput.resolvedConflicts) {
    assertKnownConflict(conflictsById, resolvedConflict.conflictId);
    const conflict = conflictsById.get(resolvedConflict.conflictId)!;
    if (conflict.status !== 'active') {
      throw new Error(`Cannot resolve conflict "${conflict.id}" because it is not active`);
    }
    conflictsById.set(conflict.id, {
      ...conflict,
      status: 'resolved',
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolvedConflict.evidence,
    });
  }

  for (const conflict of input.managerOutput.conflicts) {
    if (conflict.findingIds.length === 0) {
      assertNonEmptyIds(conflict.rawFindingIds, 'raw finding id');
    }
    assertUniqueIds(conflict.rawFindingIds, 'raw finding id');
    for (const findingId of conflict.findingIds) {
      assertKnownFinding(input.knownFindingIds, findingId);
    }
    if (conflict.rawFindingIds.length > 0) {
      assertKnownRawFindings(input.rawFindingIds, conflict.rawFindingIds);
      markRawFindingIdsUsed(input.usedRawFindingIds, conflict.rawFindingIds);
    }

    const conflictId = formatConflictId(conflict);
    const existing = conflictsById.get(conflictId);
    const base = existing !== undefined
      ? withoutConflictResolutionFields(existing)
      : {
        id: conflictId,
        status: 'active' as const,
        findingIds: [...conflict.findingIds],
        rawFindingIds: [],
        description: conflict.description,
        firstSeen: observationFromContext(input.context),
        lastSeen: observationFromContext(input.context),
      };

    conflictsById.set(conflictId, {
      ...base,
      status: 'active',
      rawFindingIds: mergeRawFindingIds(base.rawFindingIds, conflict.rawFindingIds),
      description: conflict.description,
      lastSeen: observationFromContext(input.context),
    });
  }

  return [...conflictsById.values()];
}

type ManagerOutputValidator = typeof validateFindingManagerOutput;

export function reconcileFindingLedger(input: ReconcileFindingLedgerInput): FindingLedger {
  assertCanonicalReconcileInput(input);
  return reconcileFindingLedgerWithValidator(input, validateFindingManagerOutput);
}

export function reconcileManagerActionRecovery(input: Pick<
  ReconcileFindingLedgerInput,
  'previousLedger' | 'managerOutput' | 'context'
>): FindingLedger {
  return reconcileFindingLedgerWithValidator(
    {
      ...input,
      rawFindings: [],
      provisionalFindings: [],
      rawFindingDispositions: [],
      rawProvenanceByRawFindingId: new Map(),
    },
    validateManagerActionRecoveryOutput,
  );
}

function assertCanonicalReconcileInput(input: ReconcileFindingLedgerInput): void {
  if (!Array.isArray(input.provisionalFindings)) {
    throw new Error('Reconciler input provisionalFindings must be an explicit array');
  }
  if (!Array.isArray(input.rawFindingDispositions)) {
    throw new Error('Reconciler input rawFindingDispositions must be an explicit array');
  }
  if (!(input.rawProvenanceByRawFindingId instanceof Map)) {
    throw new Error('Reconciler input rawProvenanceByRawFindingId must be an explicit Map');
  }
  for (const rawFinding of input.rawFindings) {
    if (!input.rawProvenanceByRawFindingId.has(rawFinding.rawFindingId)) {
      throw new Error(`Reconciler input is missing canonical provenance for raw finding "${rawFinding.rawFindingId}"`);
    }
  }
  const knownRawFindingIds = new Set(input.rawFindings.map((rawFinding) => rawFinding.rawFindingId));
  const dispositionRawFindingIds = new Set<string>();
  for (const disposition of input.rawFindingDispositions) {
    if (!knownRawFindingIds.has(disposition.rawFindingId)) {
      throw new Error(`Raw finding disposition references unknown raw finding "${disposition.rawFindingId}"`);
    }
    if (dispositionRawFindingIds.has(disposition.rawFindingId)) {
      throw new Error(`Raw finding "${disposition.rawFindingId}" has multiple dispositions`);
    }
    if (!RAW_FINDING_DISPOSITION_OUTCOMES.includes(disposition.outcome)) {
      throw new Error(`Raw finding disposition has unknown outcome "${disposition.outcome}"`);
    }
    if (disposition.reason.trim().length === 0) {
      throw new Error(`Raw finding disposition "${disposition.rawFindingId}" must include a reason`);
    }
    dispositionRawFindingIds.add(disposition.rawFindingId);
  }
}

function managerOutcomeRawFindingIds(output: FindingManagerOutput): string[] {
  return [
    ...output.matches.flatMap((entry) => entry.rawFindingIds),
    ...output.newFindings.flatMap((entry) => entry.rawFindingIds),
    ...output.resolvedFindings.flatMap((entry) => entry.rawFindingIds),
    ...output.reopenedFindings.flatMap((entry) => entry.rawFindingIds),
    ...output.conflicts.flatMap((entry) => entry.rawFindingIds),
  ];
}

function assertExactlyOneRawOutcome(input: ReconcileFindingLedgerInput): void {
  const knownRawFindingIds = new Set(input.rawFindings.map((rawFinding) => rawFinding.rawFindingId));
  const outcomeCounts = new Map(input.rawFindings.map((rawFinding) => [rawFinding.rawFindingId, 0]));
  const recordKnownOutcome = (rawFindingId: string): void => {
    if (knownRawFindingIds.has(rawFindingId)) {
      outcomeCounts.set(rawFindingId, outcomeCounts.get(rawFindingId)! + 1);
    }
  };
  for (const rawFindingId of managerOutcomeRawFindingIds(input.managerOutput)) {
    recordKnownOutcome(rawFindingId);
  }
  for (const spec of input.provisionalFindings) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      if (!knownRawFindingIds.has(rawFindingId)) {
        throw new Error(`Provisional outcome references unknown raw finding "${rawFindingId}"`);
      }
      recordKnownOutcome(rawFindingId);
    }
  }
  for (const disposition of input.rawFindingDispositions) {
    recordKnownOutcome(disposition.rawFindingId);
  }
  for (const [rawFindingId, count] of outcomeCounts) {
    if (count === 0) {
      throw new Error(`Raw finding "${rawFindingId}" has no explicit reconcile outcome`);
    }
    if (count > 1) {
      throw new Error(
        `Raw finding "${rawFindingId}" must have exactly one reconcile outcome; received ${count} (multiple explicit reconcile outcomes)`,
      );
    }
  }
}

function reconcileFindingLedgerWithValidator(
  input: ReconcileFindingLedgerInput,
  validateOutput: ManagerOutputValidator,
): FindingLedger {
  const validation = validateOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.rawFindings,
    managerOutput: input.managerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join('\n'));
  }
  assertExactlyOneRawOutcome(input);
  const rawFindingIds = new Set(input.rawFindings.map((finding) => finding.rawFindingId));
  assertUniqueIds(input.rawFindings.map((finding) => finding.rawFindingId), 'raw finding id');
  assertFindingLedgerProjectionInvariant(input.previousLedger);
  const previousById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const previousRawFindingsById = new Map(input.previousLedger.rawFindings.map((finding) => [
    finding.rawFindingId,
    finding,
  ]));
  const knownFindingIds = new Set(previousById.keys());
  const currentRawFindingsById = new Map(input.rawFindings.map((finding) => [finding.rawFindingId, finding]));
  let nextId = input.previousLedger.nextId;
  const usedRawFindingIds = new Set<string>();

  const updatedById = new Map<string, FindingRecord>(
    input.previousLedger.findings.map((finding) => [finding.id, { ...finding }]),
  );

  for (const match of input.managerOutput.matches) {
    assertKnownFinding(knownFindingIds, match.findingId);
    assertKnownRawFindings(rawFindingIds, match.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, match.rawFindingIds);
    const finding = updatedById.get(match.findingId)!;
    assertFindingStatus(finding, 'open', 'match');
    const matchedRawFindings = getRawFindings(input.rawFindings, match.rawFindingIds);
    const evidence = rawEvidenceFields(matchedRawFindings);
    updatedById.set(match.findingId, {
      ...finding,
      status: 'open',
      lifecycle: finding.lifecycle === 'reopened' ? 'reopened' : 'persists',
      revision: bumpRevision(finding),
      rawFindingIds: mergeRawFindingIds(finding.rawFindingIds, match.rawFindingIds),
      location: evidence.location ?? finding.location,
      description: evidence.description,
      suggestion: evidence.suggestion ?? finding.suggestion,
      reviewers: mergeReviewers(finding.reviewers, matchedRawFindings),
      lastSeen: observationFromContext(input.context),
    });
  }

  for (const resolved of input.managerOutput.resolvedFindings) {
    assertKnownFinding(knownFindingIds, resolved.findingId);
    const finding = updatedById.get(resolved.findingId)!;
    assertFindingStatus(finding, 'open', 'resolve');
    assertResolvedEvidenceRawFindings({
      finding,
      resolvedRawFindingIds: resolved.rawFindingIds,
      previousRawFindingsById,
      currentRawFindingsById,
    });
    markRawFindingIdsUsed(
      usedRawFindingIds,
      resolved.rawFindingIds.filter((rawFindingId) => currentRawFindingsById.has(rawFindingId)),
    );
    updatedById.set(resolved.findingId, {
      ...finding,
      status: 'resolved',
      lifecycle: 'resolved',
      revision: bumpRevision(finding),
      resolvedAt: input.context.timestamp,
      resolvedEvidence: resolved.evidence,
    });
  }

  for (const reopened of input.managerOutput.reopenedFindings) {
    assertKnownFinding(knownFindingIds, reopened.findingId);
    assertKnownRawFindings(rawFindingIds, reopened.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, reopened.rawFindingIds);
    const finding = updatedById.get(reopened.findingId)!;
    if (finding.status !== 'resolved' && finding.status !== 'waived' && finding.status !== 'dismissed') {
      throw new Error(`Cannot reopen finding "${finding.id}" because it is not resolved, waived, or dismissed`);
    }
    const reopenedRawFindings = getRawFindings(input.rawFindings, reopened.rawFindingIds);
    const evidence = rawEvidenceFields(reopenedRawFindings);
    const reopenedFinding = withoutResolutionFields(finding);
    if (finding.status === 'dismissed') {
      delete reopenedFinding.provisional;
    }
    updatedById.set(reopened.findingId, {
      ...reopenedFinding,
      status: 'open',
      lifecycle: 'reopened',
      revision: bumpRevision(finding),
      rawFindingIds: mergeRawFindingIds(finding.rawFindingIds, reopened.rawFindingIds),
      location: evidence.location ?? finding.location,
      description: evidence.description,
      suggestion: evidence.suggestion ?? finding.suggestion,
      reviewers: mergeReviewers(finding.reviewers, reopenedRawFindings),
      lastSeen: observationFromContext(input.context),
      reopenedEvidence: reopened.evidence,
    });
  }

  for (const waived of input.managerOutput.waivedFindings) {
    assertKnownFinding(knownFindingIds, waived.findingId);
    const finding = updatedById.get(waived.findingId)!;
    assertFindingStatus(finding, 'open', 'waive');
    if (finding.severity === 'critical') {
      throw new Error(`Cannot waive finding "${finding.id}" because critical findings must stay open`);
    }
    updatedById.set(waived.findingId, {
      ...finding,
      status: 'waived',
      lifecycle: 'waived',
      revision: bumpRevision(finding),
      waivers: [
        ...(finding.waivers ?? []),
        { reason: waived.reason, evidence: waived.evidence, decidedAt: observationFromContext(input.context) },
      ],
      lastSeen: observationFromContext(input.context),
    });
  }

  for (const note of input.managerOutput.disputeNotes) {
    assertKnownFinding(knownFindingIds, note.findingId);
    const finding = updatedById.get(note.findingId)!;
    assertFindingStatus(finding, 'open', 'record a dispute on');
    // 却下された異議は記録のみ: status は open のまま（ゲートを塞ぎ続ける）
    updatedById.set(note.findingId, {
      ...finding,
      revision: bumpRevision(finding),
      disputes: [
        ...(finding.disputes ?? []),
        { reason: note.reason, evidence: note.evidence, recordedAt: observationFromContext(input.context) },
      ],
    });
  }

  // invalidate はエンジンが decision-assembly.ts / manager-runner.ts で既に
  // 決定的検証済みの候補だけを通してくる。critical でも invalidate 可能
  // （waive とは異なりブロック対象にしない — 前提事実が成立しないという主張）。
  for (const invalidated of input.managerOutput.invalidatedFindings) {
    assertKnownFinding(knownFindingIds, invalidated.findingId);
    const finding = updatedById.get(invalidated.findingId)!;
    assertFindingStatus(finding, 'open', 'invalidate');
    updatedById.set(invalidated.findingId, {
      ...finding,
      status: 'invalidated',
      lifecycle: 'invalidated',
      revision: bumpRevision(finding),
      invalidatedAt: input.context.timestamp,
      invalidatedEvidence: invalidated.evidence,
    });
  }

  // dismiss はエンジンが decision-assembly.ts で候補集合（open な provisional
  // かつ DISMISSABLE_PROVISIONAL_KINDS）と照合済みの裁定だけを通してくる。
  // 監査記録（basis / reason / decidedAt）を残して終端し、黙って消さない。
  for (const dismissed of input.managerOutput.dismissedFindings) {
    assertKnownFinding(knownFindingIds, dismissed.findingId);
    const finding = updatedById.get(dismissed.findingId)!;
    assertFindingStatus(finding, 'open', 'dismiss');
    if (finding.provisional === undefined) {
      throw new Error(`Cannot dismiss finding "${dismissed.findingId}" because it is not provisional`);
    }
    updatedById.set(dismissed.findingId, {
      ...finding,
      status: 'dismissed',
      lifecycle: 'dismissed',
      revision: bumpRevision(finding),
      dismissal: {
        basis: dismissed.basis,
        reason: dismissed.reason,
        decidedAt: observationFromContext(input.context),
      },
    });
  }

  // duplicateDecisions: duplicate 側の rawFindingIds/reviewers/disputes を
  // canonical へ統合し、duplicate を superseded にする。canonical 自身は
  // open のまま（他の決定でこのラウンド中に状態が変わっていればそちらが優先）。
  // resolved/waived への流用は無い — 「重複だった」は「修正済み」とは別の意味。
  for (const duplicate of input.managerOutput.duplicateFindings) {
    assertKnownFinding(knownFindingIds, duplicate.canonicalFindingId);
    const canonical = updatedById.get(duplicate.canonicalFindingId)!;
    let mergedRawFindingIds = canonical.rawFindingIds;
    let mergedReviewers = canonical.reviewers;
    let mergedDisputes = canonical.disputes;
    for (const duplicateFindingId of duplicate.duplicateFindingIds) {
      assertKnownFinding(knownFindingIds, duplicateFindingId);
      const duplicateFinding = updatedById.get(duplicateFindingId)!;
      assertFindingStatus(duplicateFinding, 'open', 'supersede');
      mergedRawFindingIds = mergeRawFindingIds(mergedRawFindingIds, duplicateFinding.rawFindingIds);
      mergedReviewers = Array.from(new Set([...mergedReviewers, ...duplicateFinding.reviewers]));
      mergedDisputes = [...(mergedDisputes ?? []), ...(duplicateFinding.disputes ?? [])];
      updatedById.set(duplicateFindingId, {
        ...duplicateFinding,
        status: 'superseded',
        lifecycle: 'superseded',
        revision: bumpRevision(duplicateFinding),
        supersededByFindingId: duplicate.canonicalFindingId,
      });
    }
    const canonicalCurrent = updatedById.get(duplicate.canonicalFindingId)!;
    updatedById.set(duplicate.canonicalFindingId, {
      ...canonicalCurrent,
      revision: bumpRevision(canonicalCurrent),
      rawFindingIds: mergedRawFindingIds,
      reviewers: mergedReviewers,
      ...(mergedDisputes !== undefined && mergedDisputes.length > 0 ? { disputes: mergedDisputes } : {}),
      lastSeen: observationFromContext(input.context),
    });
  }

  const newFindings: FindingRecord[] = input.managerOutput.newFindings.map((newFinding) => {
    assertKnownRawFindings(rawFindingIds, newFinding.rawFindingIds);
    markRawFindingIdsUsed(usedRawFindingIds, newFinding.rawFindingIds);
    const rawFinding = getRawFinding(input.rawFindings, newFinding.rawFindingIds);
    const newRawFindings = getRawFindings(input.rawFindings, newFinding.rawFindingIds);
    const id = formatFindingId(nextId);
    nextId += 1;
    return buildNewFinding({
      id,
      severity: newFinding.severity,
      title: newFinding.title,
      rawFindingIds: [...newFinding.rawFindingIds],
      rawFindings: newRawFindings,
      firstSeenStepName: rawFinding.stepName,
      context: input.context,
    });
  });

  const conflicts = reconcileLedgerConflicts({
    previousLedger: input.previousLedger,
    managerOutput: input.managerOutput,
    knownFindingIds,
    rawFindingIds,
    usedRawFindingIds,
    context: input.context,
  });

  const provisionalSpecs = input.provisionalFindings;
  const provisionalNewFindings = applyProvisionalFindingSpecs({
    updatedById,
    ledger: input.previousLedger,
    specs: provisionalSpecs,
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context: input.context,
  });

  return {
    workflowName: input.context.workflowName,
    nextId,
    updatedAt: input.context.timestamp,
    findings: [...updatedById.values(), ...newFindings, ...provisionalNewFindings],
    rawFindings: mergeRawFindingDetails(input.previousLedger.rawFindings, input.rawFindings),
    conflicts,
    interpretations: input.previousLedger.interpretations,
    ...(input.previousLedger.reviewerAnomalies !== undefined
      ? { reviewerAnomalies: input.previousLedger.reviewerAnomalies }
      : {}),
  };
}

/**
 * reconcile 済みの台帳へ provisional spec を追加適用する。証跡不成立 persists の
 * 添付判断は reconcile 後の台帳に対して行うため、その時点で target が閉じていた分は
 * reconcile の provisionalFindings ではなくこの関数で upsert する。更新則は
 * applyProvisionalFindingSpecs と同一（同じ stableKey の open provisional へ
 * upsert、無ければ新規 ID を採番）。
 */
export function applyProvisionalFindingSpecsToLedger(
  ledger: FindingLedger,
  specs: readonly ProvisionalFindingSpec[],
  context: FindingReconcileContext,
): FindingLedger {
  if (specs.length === 0) {
    return ledger;
  }
  const updatedById = new Map<string, FindingRecord>(
    ledger.findings.map((finding) => [finding.id, { ...finding }]),
  );
  let nextId = ledger.nextId;
  const created = applyProvisionalFindingSpecs({
    updatedById,
    ledger,
    specs,
    allocateId: () => {
      const id = formatFindingId(nextId);
      nextId += 1;
      return id;
    },
    context,
  });
  return {
    ...ledger,
    nextId,
    updatedAt: context.timestamp,
    findings: [...updatedById.values(), ...created],
  };
}

/**
 * provisional spec を台帳へ適用する。
 *
 * - 同じ stableKey の open provisional が既にあれば同一 ID を更新する（新しい
 *   finding ID を作らない）: rawFindingIds / reason / lastSeen を更新し、
 *   revision += 1、lifecycle は 'persists'。
 * - 無ければ新規 open finding を provisional メタデータ付きで作る。
 * - 「現在のラウンドで観測されなかった」だけでは resolve しない（この関数は既存 provisional
 *   に一切触れない — 解消は clean な後続 raw の CAS 経路だけが行う）。
 */
function applyProvisionalFindingSpecs(input: {
  updatedById: Map<string, FindingRecord>;
  ledger: FindingLedger;
  specs: readonly ProvisionalFindingSpec[];
  allocateId: () => string;
  context: FindingReconcileContext;
}): FindingRecord[] {
  const observation = observationFromContext(input.context);
  const openProvisionalByStableKey = new Map<string, string>();
  for (const finding of input.updatedById.values()) {
    if (finding.status === 'open' && finding.provisional !== undefined) {
      openProvisionalByStableKey.set(finding.provisional.stableKey, finding.id);
    }
  }
  const created: FindingRecord[] = [];
  const createdByStableKey = new Map<string, FindingRecord>();

  for (const spec of input.specs) {
    const existingId = openProvisionalByStableKey.get(spec.stableKey);
    if (existingId !== undefined) {
      const existing = input.updatedById.get(existingId)!;
      input.updatedById.set(existingId, {
        ...existing,
        lifecycle: 'persists',
        rawFindingIds: mergeRawFindingIds(existing.rawFindingIds, spec.sourceRawFindingIds),
        reviewers: Array.from(new Set([...existing.reviewers, ...spec.reviewers])),
        lastSeen: observation,
        revision: bumpRevision(existing),
        provisional: {
          ...existing.provisional!,
          sourceRawFindingIds: mergeRawFindingIds(existing.provisional!.sourceRawFindingIds, spec.sourceRawFindingIds),
          reason: spec.reason,
          lastObservedAt: observation,
          interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
          ...(spec.recoveryReviewerStableKey !== undefined
            ? { recoveryReviewerStableKey: spec.recoveryReviewerStableKey }
            : {}),
          ...(spec.actionRecovery !== undefined ? { actionRecovery: spec.actionRecovery } : {}),
        },
      });
      continue;
    }
    // 同一ラウンド内で同じ stableKey の spec が複数来た場合も ID を増やさない。
    const createdExisting = createdByStableKey.get(spec.stableKey);
    if (createdExisting !== undefined) {
      createdExisting.rawFindingIds = mergeRawFindingIds(createdExisting.rawFindingIds, spec.sourceRawFindingIds);
      createdExisting.reviewers = Array.from(new Set([...createdExisting.reviewers, ...spec.reviewers]));
      createdExisting.provisional = {
        ...createdExisting.provisional!,
        sourceRawFindingIds: mergeRawFindingIds(createdExisting.provisional!.sourceRawFindingIds, spec.sourceRawFindingIds),
        interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
      };
      continue;
    }
    const entry: FindingRecord = {
      id: input.allocateId(),
      status: 'open',
      lifecycle: 'new',
      severity: spec.severity,
      title: spec.title,
      ...(spec.location !== undefined ? { location: spec.location } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.suggestion !== undefined ? { suggestion: spec.suggestion } : {}),
      reviewers: [...spec.reviewers],
      rawFindingIds: [...spec.sourceRawFindingIds],
      firstSeen: observation,
      lastSeen: observation,
      revision: 1,
      provisional: {
        kind: spec.kind,
        stableKey: spec.stableKey,
        lineageKey: spec.lineageKey,
        sourceRawFindingIds: [...spec.sourceRawFindingIds],
        reason: spec.reason,
        firstObservedAt: observation,
        lastObservedAt: observation,
        interpretationEpochs: countInterpretationEpochs(input.ledger, spec.lineageKey),
        gateEffect: 'block',
        ...(spec.recoveryReviewerStableKey !== undefined
          ? { recoveryReviewerStableKey: spec.recoveryReviewerStableKey }
          : {}),
        ...(spec.actionRecovery !== undefined ? { actionRecovery: spec.actionRecovery } : {}),
        // このラウンドの marker は commit 側で reconcile 後に追記されるため、
        // 現在ラウンド序数 = 記録済みラウンド数 + 1。
        firstObservedRound: stopBudgetRoundsCompleted(input.ledger) + 1,
      },
    };
    createdByStableKey.set(spec.stableKey, entry);
    created.push(entry);
  }
  return created;
}
