import type { FindingLedger } from './types.js';
import { isDismissCandidate } from './manager-utils.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { resolveStopBudgetLimits } from './stop-budget.js';
import type { FindingContractConfig } from './types.js';

/**
 * loop monitor judge へ注入する findings 状態の派生サマリ。judge は台帳の
 * 生データ（ledger summary）を既に受けているが、「進捗があるのに完走不能」
 * を見抜くのに必要な派生情報 — 完了ゲートの充足状況、暫定の滞留ラウンド数、
 * 解消経路の有無 — は生データからの再導出を要求されていた（実測: 健全な
 * resolved 増加だけを見て『続行』と判定し続け、ゲートを塞ぐ暫定の滞留を
 * 見逃した）。エンジンが計算済みの事実だけをここで機械生成する。
 */
export function renderLoopMonitorFindingsSummary(
  ledger: FindingLedger,
  contract: Pick<FindingContractConfig, 'stopBudget'>,
): string {
  const open = ledger.findings.filter((finding) => finding.status === 'open');
  const openProvisional = open.filter((finding) => finding.provisional !== undefined);
  const openSubstantive = open.length - openProvisional.length;
  const roundsCompleted = stopBudgetRoundsCompleted(ledger);
  const limits = resolveStopBudgetLimits(contract.stopBudget);
  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active').length;

  const provisionalLines = openProvisional.map((finding) => {
    const provisional = finding.provisional!;
    const stalledRounds = provisional.firstObservedRound !== undefined
      ? roundsCompleted - provisional.firstObservedRound + 1
      : undefined;
    const settlement = isDismissCandidate(finding)
      ? 'settlement: later clean evidence OR manager dismissDecisions'
      : 'settlement: later clean evidence only';
    return `- ${finding.id} [${provisional.kind}] ${finding.title} — stalled for ${stalledRounds !== undefined ? `${stalledRounds} manager round(s)` : 'an unknown number of rounds'}; ${settlement}`;
  });

  return [
    `Completion gate requires findings.open.count == 0; currently ${open.length} open (${openSubstantive} substantive, ${openProvisional.length} gate-blocking provisional). Active conflicts: ${activeConflicts}.`,
    `Manager rounds completed: ${roundsCompleted}/${limits.maxRounds}.`,
    ...(provisionalLines.length > 0
      ? ['Open provisional findings (these block completion until settled):', ...provisionalLines]
      : []),
  ].join('\n');
}
