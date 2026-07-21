import { FINDING_SEVERITIES, type FindingLedger, type FindingSeverity, type FindingsRuleContext } from './types.js';
import { isLedgerConflictUnadjudicated } from './adjudication-evidence.js';
import { computeReviewScopeSnapshotId } from './snapshot.js';

export function renderFindingLedgerInstructionSummary(ledger: FindingLedger): string {
  return JSON.stringify({
    version: ledger.version,
    workflowName: ledger.workflowName,
    open: ledger.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        id: finding.id,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        description: finding.description,
        suggestion: finding.suggestion,
        reviewers: finding.reviewers,
        // provisional は fixer が直接直せない system finding なので、agent が
        // 識別できるようサマリへ kind/reason を出す。
        ...(finding.provisional !== undefined
          ? { provisional: { kind: finding.provisional.kind, reason: finding.provisional.reason } }
          : {}),
      })),
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
        ...(finding.location !== undefined ? { location: finding.location } : {}),
        ...(finding.description !== undefined ? { description: finding.description } : {}),
        ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
        reviewers: finding.reviewers,
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
      // 見て NEEDS_ADJUDICATION へルーティングする。
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
      // NEEDS_ADJUDICATION へルーティングする。
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
