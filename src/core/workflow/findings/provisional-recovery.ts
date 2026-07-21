import {
  MANAGER_ACTION_RECOVERY_LIMITS,
  MANAGER_INTERPRETATION_LIMITS,
  RAW_ADJUDICATION_RECOVERY_LIMITS,
  REVIEWER_ENVELOPE_RECOVERY_LIMITS,
} from './raw-finding-limits.js';
import type { FindingLedgerEntry, FindingProvisionalMetadata } from './types.js';

/**
 * open provisional の recovery 分類。滞留クラス全廃の中核不変条件:
 * 「全ての open provisional は、レビュアーの再報告と無関係に、
 *  成功・再試行・終端裁定・fail-fast のいずれかへ必ず進む」。
 *
 * - raw-adjudication: 保存済み source raw を engine が fresh ledger へ再裁定
 *   （RawAdjudicationRecovery）。枯渇後は claim と処理失敗を分けて終端化する。
 * - interpretation: 解釈ラダーの attempt 前進（InterpretationRecovery）。
 *   枯渇後は claim と処理失敗を分けて終端化する。
 * - envelope: reviewer 出力 envelope の回復観測で機械 resolve
 *   （ReviewerEnvelopeRecovery）。
 * - action: 対象状態の充足で機械 resolve（ManagerActionRecovery — source raw を
 *   持たない stale action 系）。
 * - terminal-adjudication: recovery を使い切った / 最初から機械処理の余地が無い。
 *   dismiss 候補（内容の管轄裁定）。
 * - process-failure: engine/reviewer 処理の失敗証跡。dismiss では消さず、
 *   fixpoint / stop budget から NEEDS_ADJUDICATION へ送る。
 */
export type ProvisionalRecoveryClass =
  | 'raw-adjudication'
  | 'interpretation'
  | 'envelope'
  | 'action'
  | 'process-failure'
  | 'terminal-adjudication';

export function adjudicationAttemptsExhausted(provisional: FindingProvisionalMetadata): boolean {
  return (provisional.adjudicationAttempts ?? []).length
    >= RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayAttempts;
}

// process failure は dismiss で消さず、既存 stop-budget/fixpoint/loop-monitor が NEEDS_ADJUDICATION へ運ぶ。

function envelopeRecoveryExhausted(
  provisional: FindingProvisionalMetadata,
  roundsCompleted: number,
): boolean {
  if (provisional.firstObservedRound === undefined) {
    return true;
  }
  return roundsCompleted - provisional.firstObservedRound
    >= REVIEWER_ENVELOPE_RECOVERY_LIMITS.maxUnavailableRounds;
}

function actionRecoveryExhausted(provisional: FindingProvisionalMetadata): boolean {
  return provisional.actionRecovery === undefined
    || (provisional.actionRecoveryAttempts ?? []).length >= MANAGER_ACTION_RECOVERY_LIMITS.maxAttempts;
}

export function classifyProvisionalRecovery(
  provisional: FindingProvisionalMetadata,
  roundsCompleted: number,
): ProvisionalRecoveryClass {
  switch (provisional.kind) {
    case 'unverified-locationless':
      // locationless は機械検証も replay も成立しない主張 — 最初から管轄裁定。
      return 'terminal-adjudication';
    case 'raw-meaning-ambiguous':
      // WAL attempt があれば解釈を前進し、まだ無ければ保存済み raw を再裁定する。
      // どちらも再裁定 attempt の上限に達したら管轄裁定へ移す。
      if (provisional.interpretationEpochs >= MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage) {
        return 'terminal-adjudication';
      }
      if (adjudicationAttemptsExhausted(provisional)) {
        return 'terminal-adjudication';
      }
      return provisional.interpretationEpochs === 0 ? 'raw-adjudication' : 'interpretation';
    case 'raw-adjudication-unresolved':
      return adjudicationAttemptsExhausted(provisional) ? 'terminal-adjudication' : 'raw-adjudication';
    case 'manager-output-discarded':
      return adjudicationAttemptsExhausted(provisional) ? 'process-failure' : 'raw-adjudication';
    case 'manager-budget-exhausted':
    case 'interpretation-interrupted':
      return provisional.interpretationEpochs >= MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage
        || adjudicationAttemptsExhausted(provisional)
        ? 'process-failure'
        : 'interpretation';
    case 'reviewer-output-overflow':
      return envelopeRecoveryExhausted(provisional, roundsCompleted)
        ? 'process-failure'
        : 'envelope';
    case 'stale-precondition':
      // 保存済み source raw があれば再裁定できる。無い stale（invalidate /
      // waive / duplicate / dismiss の action 系）は対象状態の充足で機械 resolve。
      if (provisional.sourceRawFindingIds.length > 0) {
        return adjudicationAttemptsExhausted(provisional) ? 'process-failure' : 'raw-adjudication';
      }
      return actionRecoveryExhausted(provisional) ? 'process-failure' : 'action';
  }
}

export function isOpenProvisional(
  finding: FindingLedgerEntry,
): finding is FindingLedgerEntry & { provisional: FindingProvisionalMetadata } {
  return finding.status === 'open' && finding.provisional !== undefined;
}
