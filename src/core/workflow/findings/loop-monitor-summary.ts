import type { FindingLedger } from './types.js';
import type { FindingProvisionalKind, FindingsRuleContext } from '../../models/finding-types.js';
import { isDismissCandidate } from './manager-utils.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import type { FindingContractConfig } from './types.js';
import { isOutstandingReviewerAnomaly } from './reviewer-anomalies.js';
import { isReclassifiedReviewerAnomalyFinding } from './finding-entry.js';

export interface LoopMonitorProvisionalSummary {
  id: string;
  kind: FindingProvisionalKind;
  title: string | null;
  stalledRounds: number;
  /** manager の dismissDecisions で裁定可能か（isDismissCandidate 参照）。 */
  dismissable: boolean;
}

export interface LoopMonitorFindingsSummaryData {
  openCount: number;
  openSubstantiveCount: number;
  openProvisional: LoopMonitorProvisionalSummary[];
  activeConflictCount: number;
  roundsCompleted: number;
  maxRounds: number;
  reviewerAnomalies: Pick<FindingsRuleContext['reviewerAnomalies'], 'count' | 'budgetExhausted' | 'requiresGuaranteedPresentationCount' | 'restatementReadyCount' | 'claimBearingTerminalCount' | 'protocolNoiseRejectedCount'>;
}

/**
 * loop monitor judge へ注入する findings 状態の派生データ。judge は台帳の
 * 生データ（ledger summary）を既に受けているが、「進捗があるのに完走不能」
 * を見抜くのに必要な派生情報 — 完了ゲートの充足状況、暫定の滞留ラウンド数、
 * 解消経路の有無、reviewer anomaly の状態 — は生データからの再導出を要求
 * されていた（実測: 健全な resolved 増加だけを見て『続行』と判定し続け、
 * ゲートを塞ぐ暫定の滞留を見逃した）。意味契約はこのデータ構造が持ち、
 * 文面は renderLoopMonitorFindingsSummary が担う。
 */
export function buildLoopMonitorFindingsSummaryData(
  ledger: FindingLedger,
  contract: Pick<FindingContractConfig, 'stopBudget'>,
): LoopMonitorFindingsSummaryData {
  const open = ledger.findings.filter((finding) => (
    finding.status === 'open' && !isReclassifiedReviewerAnomalyFinding(finding)
  ));
  const openProvisionalFindings = open.filter((finding) => finding.provisional !== undefined);
  const roundsCompleted = stopBudgetRoundsCompleted(ledger);
  const limits = resolveStopBudgetLimits(contract.stopBudget);

  return {
    openCount: open.length,
    openSubstantiveCount: open.length - openProvisionalFindings.length,
    openProvisional: openProvisionalFindings.map((finding) => {
      const provisional = finding.provisional!;
      return {
        id: finding.id,
        kind: provisional.kind,
        title: finding.title,
        stalledRounds: roundsCompleted - provisional.firstObservedRound + 1,
        dismissable: isDismissCandidate(ledger, finding, roundsCompleted),
      };
    }),
    activeConflictCount: ledger.conflicts.filter((conflict) => conflict.status === 'active').length,
    roundsCompleted,
    maxRounds: limits.maxRounds,
    reviewerAnomalies: {
      count: (ledger.reviewerAnomalies ?? [])
        .filter(isOutstandingReviewerAnomaly).length,
      budgetExhausted: ledger.reviewIntegrity?.exhausted ?? false,
      requiresGuaranteedPresentationCount: 0,
      restatementReadyCount: 0,
      claimBearingTerminalCount: 0,
      protocolNoiseRejectedCount: (ledger.reviewerAnomalies ?? []).filter((anomaly) => (
        anomaly.kind === 'intake-contract-incomplete'
        && anomaly.intakeContract?.terminalDisposition?.workflowOutcome === 'non_claim_observation_rejected'
      )).length,
    },
  };
}

export function renderLoopMonitorFindingsSummary(
  ledger: FindingLedger,
  contract: Pick<FindingContractConfig, 'stopBudget'>,
): string {
  const data = buildLoopMonitorFindingsSummaryData(ledger, contract);
  const provisionalLines = data.openProvisional.map((provisional) => {
    const settlement = provisional.dismissable
      ? 'settlement: later clean evidence OR manager dismissDecisions'
      : 'settlement: later clean evidence only';
    return `- ${provisional.id} [${provisional.kind}] title=${JSON.stringify(provisional.title)} — stalled for ${provisional.stalledRounds} manager round(s); ${settlement}`;
  });

  return [
    `Completion gate requires findings.open.count == 0; currently ${data.openCount} open (${data.openSubstantiveCount} substantive, ${data.openProvisional.length} gate-blocking provisional). Active conflicts: ${data.activeConflictCount}.`,
    `Manager rounds completed: ${data.roundsCompleted}/${data.maxRounds}.`,
    `findings.reviewerAnomalies.count: ${data.reviewerAnomalies.count}; findings.reviewerAnomalies.budgetExhausted: ${data.reviewerAnomalies.budgetExhausted}; requiresGuaranteedPresentationCount: ${data.reviewerAnomalies.requiresGuaranteedPresentationCount}; restatementReadyCount: ${data.reviewerAnomalies.restatementReadyCount}; claimBearingTerminalCount: ${data.reviewerAnomalies.claimBearingTerminalCount}. Engine invariant: reviewer anomalies are unverified reviewer claims, not repairable product findings. Never route a reviewer anomaly to fix; only actionable open findings may be routed to fix.`,
    ...(provisionalLines.length > 0
      ? ['Open provisional findings (these block completion until settled):', ...provisionalLines]
      : []),
  ].join('\n');
}
