import {
  FINDING_SEVERITIES,
  type FindingLedger,
  type FindingLedgerEntry,
  type FindingSeverity,
  type FindingsRuleContext,
} from './types.js';
import { isLedgerConflictUnadjudicated } from './adjudication-evidence.js';
import { computeReviewScopeSnapshotId } from './snapshot.js';
import {
  selectOutstandingReviewerAnomalies,
} from './reviewer-anomaly-acknowledgement.js';

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
    familyTags: [...familyTags].sort(),
    unknownRawFindingIds: [...new Set(unknownRawFindingIds)].sort(),
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

export function renderFindingLedgerInstructionSummary(ledger: FindingLedger): string {
  const familyTagsByRawFindingId = indexRawFindingFamilyTags(ledger);
  return JSON.stringify({
    version: ledger.version,
    workflowName: ledger.workflowName,
    open: ledger.findings
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
    resolved: ledger.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
      })),
    waived: ledger.findings
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
    invalidated: ledger.findings
      .filter((finding) => finding.status === 'invalidated')
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        evidence: finding.invalidatedEvidence,
      })),
    superseded: ledger.findings
      .filter((finding) => finding.status === 'superseded')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        supersededBy: finding.supersededByFindingId,
      })),
    dismissed: ledger.findings
      .filter((finding) => finding.status === 'dismissed')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        basis: finding.dismissal?.basis,
        reason: finding.dismissal?.reason,
      })),
    conflicts: ledger.conflicts.map((conflict) => ({
      id: conflict.id,
      status: conflict.status,
      findingIds: conflict.findingIds,
      rawFindingIds: conflict.rawFindingIds,
      description: conflict.description,
    })),
  }, null, 2);
}

export function renderFindingLedgerReportSummary(ledger: FindingLedger): string {
  return JSON.stringify({
    openFindingIds: ledger.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => finding.id),
    resolvedFindingIds: ledger.findings
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => finding.id),
    waivedFindings: ledger.findings
      .filter((finding) => finding.status === 'waived')
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        reason: finding.waivers?.at(-1)?.reason,
        evidence: finding.waivers?.at(-1)?.evidence,
      })),
    invalidatedFindingIds: ledger.findings
      .filter((finding) => finding.status === 'invalidated')
      .map((finding) => finding.id),
    supersededFindingIds: ledger.findings
      .filter((finding) => finding.status === 'superseded')
      .map((finding) => finding.id),
    dismissedFindingIds: ledger.findings
      .filter((finding) => finding.status === 'dismissed')
      .map((finding) => finding.id),
    conflictIds: ledger.conflicts.map((conflict) => conflict.id),
  }, null, 2);
}

/** 台帳に open な指摘が存在するか（異議申告ガイドの注入判定に使う）。 */
export function ledgerHasOpenFindings(ledger: FindingLedger): boolean {
  return ledger.findings.some((finding) => finding.status === 'open');
}

/** 台帳に waived な指摘が存在するか（waived 除外指示の注入判定に使う）。 */
export function ledgerHasWaivedFindings(ledger: FindingLedger): boolean {
  return ledger.findings.some((finding) => finding.status === 'waived');
}

export function ledgerHasDismissedFindings(ledger: FindingLedger): boolean {
  return ledger.findings.some((finding) => finding.status === 'dismissed');
}

export function buildFindingsRuleContext(ledger: FindingLedger, cwd: string): FindingsRuleContext {
  const openItems = ledger.findings.filter((finding) => finding.status === 'open');
  const familyTagsByRawFindingId = indexRawFindingFamilyTags(ledger);
  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active');
  const unpromotedAnomalies = (ledger.reviewerAnomalies ?? [])
    .filter((anomaly) => anomaly.promotedFindingId === undefined);
  const reviewScopeSnapshotId = activeConflicts.length > 0 || unpromotedAnomalies.length > 0
    ? computeReviewScopeSnapshotId(cwd)
    : undefined;
  let unadjudicatedConflictCount = 0;
  if (activeConflicts.length > 0) {
    unadjudicatedConflictCount = activeConflicts.filter((conflict) => (
      isLedgerConflictUnadjudicated(conflict, ledger, reviewScopeSnapshotId!)
    )).length;
  }
  const outstandingAnomalies = reviewScopeSnapshotId === undefined
    ? []
    : selectOutstandingReviewerAnomalies(ledger, reviewScopeSnapshotId);
  const acknowledgedAnomalyCount = unpromotedAnomalies.length - outstandingAnomalies.length;
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
    // count は既存どおり未昇格 anomaly の総数。ack によって意味を変えず、
    // 現在の snapshot/evidence に対する completion 判定は outstanding を使う。
    reviewerAnomalies: {
      count: unpromotedAnomalies.length,
      outstanding: outstandingAnomalies.length,
      acknowledged: acknowledgedAnomalyCount,
      // review-integrity requirement: review-integrity 予算が尽きたか（台帳側で計算・
      // 永続化済み。ここは読むだけ）。shared final gate はこの値だけでは
      // 再計画せず、supervisor の明示判断と有限停止監視を優先する。
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
