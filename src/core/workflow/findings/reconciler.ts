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
  RawFinding,
} from './types.js';
import { assertLedgerIdAllocationInvariant } from './ledger-validation.js';
import { compareRfc3339Timestamps } from '../../models/rfc3339.js';
import {
  validateFindingManagerOutput,
  validateManagerActionRecoveryOutput,
} from './manager-output-validation.js';
import { computeLineageKey, computeProvisionalStableKey, computeReviewerStableKey } from './raw-canonicalization.js';
import { countInterpretationEpochs, normalizeProvisionalInterpretationEpochs } from './interpretation-wal.js';
import { formatConflictId, formatConflictSignature } from './conflict-identity.js';
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
  /**
   * どの決定にも現れなかった raw の着地先。「未言及 raw → new
   * finding」フォールバックを廃止した（不採用の意味が消える / 根拠不成立の
   * 再報告が新規 finding として洗浄される）。代わりに、呼び出し元
   * （manager-runner.ts）が未言及 raw を provisional spec としてここへ渡す。
   * 万一渡し漏れた raw が残った場合も reconciler 自身が defense-in-depth の
   * fallback provisional に変換する（黙って消してゲートを開けない）。
   */
  provisionalFindings?: ProvisionalFindingSpec[];
  /**
   * 保存直前の再照合で項目単位で不採用になり、かつ provisional spec 側で
   * 既に着地が決まっている raw finding id。defense-in-depth fallback の
   * 対象から除外する（二重着地の防止）。
   */
  excludedFromUnmentionedFallbackRawFindingIds?: ReadonlySet<string>;
  /**
   * raw finding id → canonicalization が計算した provenance（reviewerStableKey /
   * lineageKey）。defense-in-depth fallback はこれを使い、reviewer 名からの
   * 別キー導出を行わない（contract invariant: 同一 lineage の provisional が intake 経路と
   * fallback 経路で別 stableKey になり増殖していた）。manager-runner 経路は
   * 常にこのマップを渡す。マップに無い raw（旧経路・テストの手組み raw）だけが
   * 最終手段の導出に落ちる。
   */
  rawProvenanceByRawFindingId?: ReadonlyMap<string, { reviewerStableKey: string; lineageKey: string }>;
}

function formatFindingId(nextId: number): string {
  return `F-${String(nextId).padStart(4, '0')}`;
}

function findMatchingConflicts(
  conflictsById: ReadonlyMap<string, FindingLedgerConflict>,
  conflict: Pick<FindingLedgerConflict, 'findingIds' | 'rawFindingIds'>,
): FindingLedgerConflict[] {
  const signature = formatConflictSignature(conflict);
  return [...conflictsById.values()].filter((existing) => formatConflictSignature(existing) === signature);
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

/**
 * 楽観的前提条件（CAS）の版数。エントリを変更する全ての決定適用で
 * +1 する。省略時（既存 v1 ledger）は 1 とみなす。
 */
function bumpRevision(finding: Pick<FindingRecord, 'revision'>): number {
  return (finding.revision ?? 1) + 1;
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
    // revision / provisional は解消情報ではないため reopen でも保持する
    // （落とすと CAS の版数が巻き戻り、stale 検出が誤って成功する）。
    ...(finding.revision !== undefined ? { revision: finding.revision } : {}),
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
  };
}

function mergeConflictHistory(conflicts: readonly FindingLedgerConflict[]): Pick<
  FindingLedgerConflict,
  'adjudications' | 'adjudicationAttempts'
> {
  const adjudications = conflicts
    .flatMap((conflict) => conflict.adjudications ?? [])
    .sort((left, right) => (
      compareRfc3339Timestamps(left.decidedAt.timestamp, right.decidedAt.timestamp)
      || left.evidenceHash.localeCompare(right.evidenceHash)
    ));
  const adjudicationAttempts = conflicts
    .flatMap((conflict) => conflict.adjudicationAttempts ?? [])
    .sort((left, right) => (
      compareRfc3339Timestamps(left.startedAt.timestamp, right.startedAt.timestamp)
      || left.evidenceHash.localeCompare(right.evidenceHash)
      || left.reservationToken.localeCompare(right.reservationToken)
    ));
  return {
    ...(adjudications.length > 0 ? { adjudications } : {}),
    ...(adjudicationAttempts.length > 0 ? { adjudicationAttempts } : {}),
  };
}

function selectConflictSurvivor(conflicts: readonly FindingLedgerConflict[]): FindingLedgerConflict | undefined {
  return [...conflicts].sort((left, right) => (
    compareRfc3339Timestamps(left.firstSeen.timestamp, right.firstSeen.timestamp)
    || left.id.localeCompare(right.id)
  ))[0];
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

    const matchingConflicts = findMatchingConflicts(conflictsById, conflict);
    const existing = selectConflictSurvivor(matchingConflicts);
    const conflictId = existing?.id ?? formatConflictId(conflict);
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

    for (const matchingConflict of matchingConflicts) {
      if (matchingConflict.id !== conflictId) {
        conflictsById.delete(matchingConflict.id);
      }
    }

    conflictsById.set(conflictId, {
      ...base,
      status: 'active',
      rawFindingIds: mergeRawFindingIds(
        mergeRawFindingIds(
          base.rawFindingIds,
          matchingConflicts
            .filter((matchingConflict) => matchingConflict.id !== conflictId)
            .flatMap((matchingConflict) => matchingConflict.rawFindingIds),
        ),
        conflict.rawFindingIds,
      ),
      description: conflict.description,
      lastSeen: observationFromContext(input.context),
      ...mergeConflictHistory(matchingConflicts),
    });
  }

  return [...conflictsById.values()];
}

type ManagerOutputValidator = typeof validateFindingManagerOutput;

export function reconcileFindingLedger(input: ReconcileFindingLedgerInput): FindingLedger {
  return reconcileFindingLedgerWithValidator(input, validateFindingManagerOutput);
}

export function reconcileManagerActionRecovery(input: Pick<
  ReconcileFindingLedgerInput,
  'previousLedger' | 'managerOutput' | 'context'
>): FindingLedger {
  return reconcileFindingLedgerWithValidator(
    { ...input, rawFindings: [] },
    validateManagerActionRecoveryOutput,
  );
}

function reconcileFindingLedgerWithValidator(
  input: ReconcileFindingLedgerInput,
  validateOutput: ManagerOutputValidator,
): FindingLedger {
  // 手組みの manager output（zod を経ない経路）でも新配列の欠落で落ちないよう
  // 入口で正規化する。
  input = {
    ...input,
    managerOutput: {
      ...input.managerOutput,
      waivedFindings: input.managerOutput.waivedFindings ?? [],
      disputeNotes: input.managerOutput.disputeNotes ?? [],
      invalidatedFindings: input.managerOutput.invalidatedFindings ?? [],
      duplicateFindings: input.managerOutput.duplicateFindings ?? [],
      dismissedFindings: input.managerOutput.dismissedFindings ?? [],
    },
  };
  const validation = validateOutput({
    previousLedger: input.previousLedger,
    rawFindings: input.rawFindings,
    managerOutput: input.managerOutput,
    priorStepResponseText: input.priorStepResponseText,
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join('\n'));
  }
  const rawFindingIds = new Set(input.rawFindings.map((finding) => finding.rawFindingId));
  assertUniqueIds(input.rawFindings.map((finding) => finding.rawFindingId), 'raw finding id');
  assertLedgerIdAllocationInvariant(input.previousLedger);
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

  // 「未言及 raw → new finding」フォールバックは廃止した。
  // どの決定にも現れなかった raw は呼び出し元が provisional spec として渡し、
  // 渡し漏れも defense-in-depth でここが provisional に変換する（黙って消して
  // ゲートを開けない。新規 finding への昇格もしない — 根拠不成立の再報告が
  // 新規 finding として洗浄される経路だった）。
  const excludedFromUnmentionedFallback = input.excludedFromUnmentionedFallbackRawFindingIds ?? new Set<string>();
  const provisionalSpecs: ProvisionalFindingSpec[] = [...(input.provisionalFindings ?? [])];
  const provisionalRawIds = new Set(provisionalSpecs.flatMap((spec) => spec.sourceRawFindingIds));
  for (const rawFinding of input.rawFindings) {
    // 解消確認は問題の観測ではない（適用されなかった確認の衝突化は呼び出し元の
    // CAS 経路が担う）ため、fallback provisional の対象にしない。
    if (rawFinding.relation === 'resolution_confirmation') {
      continue;
    }
    if (usedRawFindingIds.has(rawFinding.rawFindingId)
      || provisionalRawIds.has(rawFinding.rawFindingId)
      || excludedFromUnmentionedFallback.has(rawFinding.rawFindingId)) {
      continue;
    }
    // canonicalization が計算した provenance を最優先で使う（contract invariant: 別キー
    // 導出は同一 lineage の provisional を増殖させる）。manager-runner 経路は
    // 常にマップを渡すため、以下の導出はマップ外の raw（旧経路・手組み raw）
    // だけの最終手段。
    const provenance = input.rawProvenanceByRawFindingId?.get(rawFinding.rawFindingId);
    const reviewerStableKey = provenance?.reviewerStableKey ?? computeReviewerStableKey({
      workflowName: input.context.workflowName,
      callNamespace: '',
      parentStepName: input.context.stepName,
      reviewerPersonaKey: rawFinding.reviewer,
    });
    const lineageKey = provenance?.lineageKey ?? computeLineageKey({
      ...(rawFinding.targetFindingId !== undefined ? { targetFindingId: rawFinding.targetFindingId } : {}),
      ...(rawFinding.location !== undefined ? { location: rawFinding.location } : {}),
      title: rawFinding.title,
      familyTag: rawFinding.familyTag,
    });
    provisionalSpecs.push({
      kind: 'raw-adjudication-unresolved',
      stableKey: computeProvisionalStableKey({ reviewerStableKey, lineageKey, provisionalKind: 'raw-adjudication-unresolved' }),
      lineageKey,
      sourceRawFindingIds: [rawFinding.rawFindingId],
      reason: `Raw finding "${rawFinding.rawFindingId}" was not referenced by any decision; kept as a gate-blocking provisional instead of being dropped or promoted to a new finding`,
      title: rawFinding.title,
      severity: rawFinding.severity,
      ...(rawFinding.location !== undefined ? { location: rawFinding.location } : {}),
      description: rawFinding.description,
      ...(rawFinding.suggestion !== undefined ? { suggestion: rawFinding.suggestion } : {}),
      reviewers: [rawFinding.reviewer],
    });
  }

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

  return normalizeProvisionalInterpretationEpochs({
    version: 1,
    workflowName: input.context.workflowName,
    nextId,
    updatedAt: input.context.timestamp,
    findings: [...updatedById.values(), ...newFindings, ...provisionalNewFindings],
    rawFindings: mergeRawFindingDetails(input.previousLedger.rawFindings, input.rawFindings),
    conflicts,
    ...(input.previousLedger.interpretations !== undefined
      ? { interpretations: input.previousLedger.interpretations }
      : {}),
  });
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
    return normalizeProvisionalInterpretationEpochs(ledger);
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
  return normalizeProvisionalInterpretationEpochs({
    ...ledger,
    nextId,
    updatedAt: context.timestamp,
    findings: [...updatedById.values(), ...created],
  });
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
