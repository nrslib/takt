import { FINDING_SEVERITIES, type FindingLedger, type FindingSeverity, type FindingsRuleContext } from './types.js';
import { isLedgerConflictUnadjudicated } from './adjudication-evidence.js';

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
        // provisional は fixer が直接直せない system finding（v2 梯子設計 §7）。
        // agent がそれを識別できるようサマリへ kind/reason を出す（追加のみ）。
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
    // 監査可視化（codex ブロッカー B5）: invalidated（前提事実の不成立を
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

export function buildFindingsRuleContext(ledger: FindingLedger): FindingsRuleContext {
  const openItems = ledger.findings.filter((finding) => finding.status === 'open');
  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active');
  const unadjudicatedConflictCount = activeConflicts.filter((conflict) => (
    isLedgerConflictUnadjudicated(conflict, ledger)
  )).length;
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
    // count > 0 での COMPLETE を最終不変条件として拒否する（設計書 §7）。
    provisional: {
      count: openItems.filter((finding) => finding.provisional !== undefined).length,
      items: openItems
        .filter((finding) => finding.provisional !== undefined)
        .map((finding) => ({
          id: finding.id,
          kind: finding.provisional!.kind,
          reason: finding.provisional!.reason,
        })),
    },
    resolved: {
      count: ledger.findings.filter((finding) => finding.status === 'resolved').length,
    },
    waived: {
      count: ledger.findings.filter((finding) => finding.status === 'waived').length,
    },
    // 監査可視化のみ（codex ブロッカー B5）。gate 条件は open/conflicts のまま
    // 変えない — count を公開するだけで、既存ルール式の意味は変わらない。
    invalidated: {
      count: ledger.findings.filter((finding) => finding.status === 'invalidated').length,
    },
    superseded: {
      count: ledger.findings.filter((finding) => finding.status === 'superseded').length,
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
