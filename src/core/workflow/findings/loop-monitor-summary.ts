import type { FindingLedger } from './types.js';
import type { FindingProvisionalKind, FindingsRuleContext } from '../../models/finding-types.js';
import type { Language } from '../../models/config-types.js';
import { isDismissCandidate } from './manager-utils.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import type { FindingContractConfig } from './types.js';

export interface LoopMonitorProvisionalSummary {
  id: string;
  kind: FindingProvisionalKind;
  title: string;
  /** undefined = firstObservedRound の無い既存台帳（滞留不明）。 */
  stalledRounds: number | undefined;
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
  reviewerAnomalies: FindingsRuleContext['reviewerAnomalies'];
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
  const open = ledger.findings.filter((finding) => finding.status === 'open');
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
        stalledRounds: provisional.firstObservedRound !== undefined
          ? roundsCompleted - provisional.firstObservedRound + 1
          : undefined,
        dismissable: isDismissCandidate(finding, roundsCompleted),
      };
    }),
    activeConflictCount: ledger.conflicts.filter((conflict) => conflict.status === 'active').length,
    roundsCompleted,
    maxRounds: limits.maxRounds,
    reviewerAnomalies: {
      count: (ledger.reviewerAnomalies ?? [])
        .filter((anomaly) => anomaly.promotedFindingId === undefined).length,
      budgetExhausted: ledger.reviewIntegrity?.exhausted ?? false,
    },
  };
}

export function renderLoopMonitorFindingsSummary(
  ledger: FindingLedger,
  contract: Pick<FindingContractConfig, 'stopBudget'>,
  language: Language | undefined,
): string {
  const data = buildLoopMonitorFindingsSummaryData(ledger, contract);
  const provisionalLines = data.openProvisional.map((provisional) => {
    const stalled = provisional.stalledRounds !== undefined
      ? (language === 'ja'
          ? `${provisional.stalledRounds} managerラウンド`
          : `${provisional.stalledRounds} manager round(s)`)
      : (language === 'ja' ? '不明なラウンド数' : 'an unknown number of rounds');
    const settlement = provisional.dismissable
      ? (language === 'ja'
          ? '解消経路: 後続のclean evidenceまたはmanager dismissDecisions'
          : 'settlement: later clean evidence OR manager dismissDecisions')
      : (language === 'ja'
          ? '解消経路: 後続のclean evidenceのみ'
          : 'settlement: later clean evidence only');
    return language === 'ja'
      ? `- ${provisional.id} [${provisional.kind}] ${provisional.title} — ${stalled}滞留; ${settlement}`
      : `- ${provisional.id} [${provisional.kind}] ${provisional.title} — stalled for ${stalled}; ${settlement}`;
  });

  if (language === 'ja') {
    return [
      `完了ゲートは findings.open.count == 0 を要求します。現在は open ${data.openCount}件（substantive ${data.openSubstantiveCount}件、ゲートを塞ぐ provisional ${data.openProvisional.length}件）、active conflict ${data.activeConflictCount}件です。`,
      `Managerラウンド完了数: ${data.roundsCompleted}/${data.maxRounds}。`,
      `findings.reviewerAnomalies.count: ${data.reviewerAnomalies.count}、findings.reviewerAnomalies.budgetExhausted: ${data.reviewerAnomalies.budgetExhausted}。Reviewer anomaly は証拠不成立を示す非 actionable な状態であり、product finding ではありません。actionable な open finding がない限り repair へ送らず、claimed content を repair 根拠にしないでください。`,
      ...(provisionalLines.length > 0
        ? ['Open provisional findings（解消まで完了を阻止）:', ...provisionalLines]
        : []),
    ].join('\n');
  }

  return [
    `Completion gate requires findings.open.count == 0; currently ${data.openCount} open (${data.openSubstantiveCount} substantive, ${data.openProvisional.length} gate-blocking provisional). Active conflicts: ${data.activeConflictCount}.`,
    `Manager rounds completed: ${data.roundsCompleted}/${data.maxRounds}.`,
    `findings.reviewerAnomalies.count: ${data.reviewerAnomalies.count}; findings.reviewerAnomalies.budgetExhausted: ${data.reviewerAnomalies.budgetExhausted}. Reviewer anomalies are non-actionable evidence failures, not product findings. Do not send them to repair without an actionable open finding, and do not use claimed content as repair evidence.`,
    ...(provisionalLines.length > 0
      ? ['Open provisional findings (these block completion until settled):', ...provisionalLines]
      : []),
  ].join('\n');
}
