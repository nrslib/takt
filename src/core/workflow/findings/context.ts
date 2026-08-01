import {
  FINDING_SEVERITIES,
  type FindingLedger,
  type FindingLedgerEntry,
  type FindingSeverity,
  type FindingsRuleContext,
} from './types.js';
import { isLedgerConflictUnadjudicated } from './adjudication-evidence.js';
import { computeReviewScopeSnapshotId } from './snapshot.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';

function indexRawFindingFamilyTags(ledger: FindingLedger): ReadonlyMap<string, string> {
  const familyTagsByRawFindingId = new Map<string, string>();
  for (const finding of ledger.rawFindings) {
    const existingFamilyTag = familyTagsByRawFindingId.get(finding.rawFindingId);
    if (existingFamilyTag !== undefined && existingFamilyTag !== finding.familyTag) {
      throw new Error(
        `Raw finding "${finding.rawFindingId}" has conflicting family tags: `
        + `"${existingFamilyTag}" and "${finding.familyTag}"`,
      );
    }
    familyTagsByRawFindingId.set(finding.rawFindingId, finding.familyTag);
  }
  return familyTagsByRawFindingId;
}

function deriveFindingFamilyTags(
  finding: FindingLedgerEntry,
  familyTagsByRawFindingId: ReadonlyMap<string, string>,
): { familyTags: string[]; unknownRawFindingIds: string[] } {
  const familyTags = new Set<string>();
  const unknownRawFindingIds: string[] = [];
  for (const rawFindingId of finding.rawFindingIds) {
    const familyTag = familyTagsByRawFindingId.get(rawFindingId);
    if (familyTag === undefined) {
      unknownRawFindingIds.push(rawFindingId);
    } else {
      familyTags.add(familyTag);
    }
  }
  return {
    familyTags: [...familyTags].sort(compareBinaryStrings),
    unknownRawFindingIds: [...new Set(unknownRawFindingIds)].sort(compareBinaryStrings),
  };
}

export function selectActionableFindingEntries(ledger: FindingLedger): FindingLedgerEntry[] {
  return ledger.findings.filter((finding) => (
    finding.status === 'open' && finding.provisional === undefined
  ));
}

function buildActionableFindingLedgerInstructionSummary(
  ledger: FindingLedger,
  findingIds?: readonly string[],
): {
  workflowName: string;
  open: Array<{
    id: string;
    lifecycle: FindingLedgerEntry['lifecycle'];
    severity: FindingSeverity;
    title: string;
    location: string | undefined;
    description: string | undefined;
    suggestion: string | undefined;
    rawFindingIds: string[];
    familyTags: string[];
  }>;
} {
  const selectedIds = findingIds === undefined ? undefined : new Set(findingIds);
  const familyTagsByRawFindingId = indexRawFindingFamilyTags(ledger);
  return {
    workflowName: ledger.workflowName,
    open: selectActionableFindingEntries(ledger)
      .filter((finding) => selectedIds === undefined || selectedIds.has(finding.id))
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        description: finding.description,
        suggestion: finding.suggestion,
        rawFindingIds: finding.rawFindingIds,
        familyTags: deriveFindingFamilyTags(finding, familyTagsByRawFindingId).familyTags,
      })),
  };
}

export function renderActionableFindingLedgerInstructionSummary(
  ledger: FindingLedger,
  findingIds?: readonly string[],
): string {
  return JSON.stringify(buildActionableFindingLedgerInstructionSummary(ledger, findingIds), null, 2);
}

export function renderCompactActionableFindingLedgerInstructionSummary(
  ledger: FindingLedger,
  findingIds?: readonly string[],
): string {
  const summary = buildActionableFindingLedgerInstructionSummary(ledger, findingIds);
  return JSON.stringify({
    ...summary,
    open: summary.open.map(({ rawFindingIds: _rawFindingIds, ...finding }) => finding),
  }, null, 2);
}

function resolveFindingLedgerInstructionProjection(ledger: FindingLedger): FindingLedger {
  const completed = ledger.pendingManagerCommit?.completed;
  if (completed === undefined) {
    return ledger;
  }
  return {
    workflowName: ledger.workflowName,
    nextId: completed.nextId,
    updatedAt: completed.updatedAt,
    findings: completed.findings,
    rawFindings: completed.rawFindings,
    conflicts: completed.conflicts,
    interpretations: completed.interpretations,
    ...(completed.fixpoint !== undefined ? { fixpoint: completed.fixpoint } : {}),
    ...(completed.stopBudget !== undefined ? { stopBudget: completed.stopBudget } : {}),
    ...(completed.reviewerAnomalies !== undefined
      ? { reviewerAnomalies: completed.reviewerAnomalies }
      : {}),
    ...(completed.reviewIntegrity !== undefined
      ? { reviewIntegrity: completed.reviewIntegrity }
      : {}),
    pendingManagerCommit: ledger.pendingManagerCommit,
  };
}

export function resolveFindingLedgerReviewMode(ledger: FindingLedger): 'initial' | 'follow_up' {
  const projection = resolveFindingLedgerInstructionProjection(ledger);
  const hasReviewHistory = projection.findings.length > 0
    || projection.rawFindings.length > 0
    || projection.conflicts.length > 0
    || projection.interpretations.length > 0
    || (projection.reviewerAnomalies?.length ?? 0) > 0
    || stopBudgetRoundsCompleted(projection) > 0
    || projection.pendingManagerCommit !== undefined;
  return hasReviewHistory ? 'follow_up' : 'initial';
}

export function renderFindingLedgerInstructionSummary(ledger: FindingLedger): string {
  const projection = resolveFindingLedgerInstructionProjection(ledger);
  const familyTagsByRawFindingId = indexRawFindingFamilyTags(projection);
  return JSON.stringify({
    workflowName: projection.workflowName,
    reviewMode: resolveFindingLedgerReviewMode(projection),
    open: projection.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => {
        const familyContext = deriveFindingFamilyTags(finding, familyTagsByRawFindingId);
        return {
          id: finding.id,
          lifecycle: finding.lifecycle,
          severity: finding.severity,
          title: finding.title,
          location: finding.location,
          description: finding.description,
          suggestion: finding.suggestion,
          reviewers: finding.reviewers,
          ...familyContext,
          // provisional は fixer が直接直せない system finding なので、agent が
          // 識別できるようサマリへ kind/reason を出す。
          ...(finding.provisional !== undefined
            ? { provisional: { kind: finding.provisional.kind, reason: finding.provisional.reason } }
            : {}),
        };
      }),
    resolved: projection.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
      })),
    waived: projection.findings
      .filter((finding) => finding.status === 'waived')
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        waiver: finding.waivers?.at(-1),
      })),
    // invalidated（前提事実の不成立を
    // エンジンが検証済み）と superseded（重複として canonical へ統合済み）は
    // ブロッキング対象外だが、「消えた」のではなく「こう裁定された」ことが
    // サマリから追えるようにする。既存キーの形式は変えない（追加のみ）。
    invalidated: projection.findings
      .filter((finding) => finding.status === 'invalidated')
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        evidence: finding.invalidatedEvidence,
      })),
    superseded: projection.findings
      .filter((finding) => finding.status === 'superseded')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        supersededBy: finding.supersededByFindingId,
      })),
    dismissed: projection.findings
      .filter((finding) => finding.status === 'dismissed')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        basis: finding.dismissal?.basis,
        reason: finding.dismissal?.reason,
      })),
    conflicts: projection.conflicts.map((conflict) => ({
      id: conflict.id,
      status: conflict.status,
      findingIds: conflict.findingIds,
      rawFindingIds: conflict.rawFindingIds,
      description: conflict.description,
    })),
  }, null, 2);
}

export function renderFindingLedgerReportSummary(ledger: FindingLedger): string {
  const projection = resolveFindingLedgerInstructionProjection(ledger);
  return JSON.stringify({
    openFindingIds: projection.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => finding.id),
    resolvedFindingIds: projection.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => finding.id),
    waivedFindings: projection.findings
      .filter((finding) => finding.status === 'waived')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        reason: finding.waivers?.at(-1)?.reason,
        evidence: finding.waivers?.at(-1)?.evidence,
      })),
    invalidatedFindingIds: projection.findings
      .filter((finding) => finding.status === 'invalidated')
      .map((finding) => finding.id),
    supersededFindingIds: projection.findings
      .filter((finding) => finding.status === 'superseded')
      .map((finding) => finding.id),
    dismissedFindingIds: projection.findings
      .filter((finding) => finding.status === 'dismissed')
      .map((finding) => finding.id),
    conflictIds: projection.conflicts.map((conflict) => conflict.id),
  }, null, 2);
}

/** 台帳に open な指摘が存在するか（異議申告ガイドの注入判定に使う）。 */
export function ledgerHasOpenFindings(ledger: FindingLedger): boolean {
  return resolveFindingLedgerInstructionProjection(ledger).findings
    .some((finding) => finding.status === 'open');
}

/** 台帳に waived な指摘が存在するか（waived 除外指示の注入判定に使う）。 */
export function ledgerHasWaivedFindings(ledger: FindingLedger): boolean {
  return resolveFindingLedgerInstructionProjection(ledger).findings
    .some((finding) => finding.status === 'waived');
}

export function ledgerHasDismissedFindings(ledger: FindingLedger): boolean {
  return resolveFindingLedgerInstructionProjection(ledger).findings
    .some((finding) => finding.status === 'dismissed');
}

export function buildFindingsRuleContext(ledger: FindingLedger, cwd: string): FindingsRuleContext {
  const openItems = ledger.findings.filter((finding) => finding.status === 'open');
  const familyTagsByRawFindingId = indexRawFindingFamilyTags(ledger);
  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active');
  let unadjudicatedConflictCount = 0;
  if (activeConflicts.length > 0) {
    const reviewScopeSnapshotId = computeReviewScopeSnapshotId(cwd);
    unadjudicatedConflictCount = activeConflicts.filter((conflict) => (
      isLedgerConflictUnadjudicated(conflict, ledger, reviewScopeSnapshotId)
    )).length;
  }
  const bySeverity = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [severity, 0]),
  ) as Record<FindingSeverity, number>;
  for (const finding of openItems) {
    bySeverity[finding.severity] += 1;
  }

  return {
    open: {
      count: openItems.length,
      bySeverity,
      items: openItems.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        description: finding.description,
        suggestion: finding.suggestion,
        reviewers: finding.reviewers,
        ...deriveFindingFamilyTags(finding, familyTagsByRawFindingId),
      })),
    },
    // provisional は status=open の finding に付く optional メタデータなので
    // open.count にも含まれる（既存の findings.open.count == 0 ゲートは安全側）。
    // builtin workflow はこの count を見て need_replan へルーティングし、エンジンは
    // count > 0 での COMPLETE を最終不変条件として拒否する。
    provisional: {
      count: openItems.filter((finding) => finding.provisional !== undefined).length,
      // 直前の findings-manager ラウンドが fixpoint に達したか
      // （台帳側で計算・永続化済み。ここは読むだけ）。builtin workflow はこれを
      // 見て要件を維持した再計画へルーティングする。
      fixpoint: ledger.fixpoint?.reached ?? false,
      items: openItems
        .filter((finding) => finding.provisional !== undefined)
        .map((finding) => ({
          id: finding.id,
          kind: finding.provisional!.kind,
          reason: finding.provisional!.reason,
        })),
    },
    // 累積ラウンド数・
    // 経過時間が上限に達したか（台帳側で計算・永続化済み。ここは読むだけ）。
    // provisional バケットとは独立 — fixpoint が成立しない churn でも、
    // ラウンド数だけで機械的に判定できる最終防波堤。
    rounds: {
      budgetExhausted: ledger.stopBudget?.exhausted ?? false,
    },
    resolved: {
      count: ledger.findings.filter((finding) => finding.status === 'resolved').length,
    },
    waived: {
      count: ledger.findings.filter((finding) => finding.status === 'waived').length,
    },
    // 監査可視化のみ。gate 条件は open/conflicts のまま
    // 変えない — count を公開するだけで、既存ルール式の意味は変わらない。
    invalidated: {
      count: ledger.findings.filter((finding) => finding.status === 'invalidated').length,
    },
    superseded: {
      count: ledger.findings.filter((finding) => finding.status === 'superseded').length,
    },
    // review-integrity protocol: 二系統台帳の review-integrity 側。未昇格（promotedFindingId
    // 無し）の anomaly だけを数える — 昇格済みは既に product finding 側
    // （open/provisional 等）でカウントされているため二重計上しない。product
    // gate（COMPLETE 判定）はこの count を一切参照しない — reviewerAnomalies は
    // findings 配列と別物なので、参照しなくても構造的に gate を塞げない。
    reviewerAnomalies: {
      count: (ledger.reviewerAnomalies ?? []).filter((anomaly) => anomaly.promotedFindingId === undefined).length,
      // review-integrity requirement: review-integrity 予算が尽きたか（台帳側で計算・
      // 永続化済み。ここは読むだけ）。未昇格 anomaly が残る限り COMPLETE は許さず
      // 再レビューへ送るが、有限回で補完できなければ builtin はこれを見て
      // 要件を維持した再計画へルーティングする。
      budgetExhausted: ledger.reviewIntegrity?.exhausted ?? false,
    },
    conflicts: {
      count: activeConflicts.length,
      items: activeConflicts.map((conflict) => ({
        id: conflict.id,
        status: conflict.status,
        findingIds: conflict.findingIds,
        rawFindingIds: conflict.rawFindingIds,
        description: conflict.description,
      })),
      unadjudicated: {
        count: unadjudicatedConflictCount,
      },
    },
  };
}
