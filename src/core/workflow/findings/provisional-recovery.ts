import { MANAGER_ADJUDICATION_LIMITS, MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import type { FindingLedgerEntry, FindingProvisionalMetadata } from './types.js';

/**
 * open provisional の recovery 分類。滞留クラス全廃の中核不変条件:
 * 「全ての open provisional は、レビュアーの再報告と無関係に、
 *  成功・再試行・終端裁定・fail-fast のいずれかへ必ず進む」。
 *
 * - raw-adjudication: 保存済み source raw を engine が fresh ledger へ再裁定
 *   （RawAdjudicationRecovery）。attempt 枯渇で terminal-adjudication へ遷移。
 * - interpretation: 解釈ラダーの attempt 前進（InterpretationRecovery）。
 *   epochs 枯渇で terminal-adjudication へ遷移。
 * - envelope: reviewer 出力 envelope の回復観測で機械 resolve
 *   （ReviewerEnvelopeRecovery）。
 * - action: 対象状態の充足で機械 resolve（ManagerActionRecovery — source raw を
 *   持たない stale action 系）。
 * - terminal-adjudication: recovery を使い切った / 最初から機械処理の余地が無い。
 *   dismiss 候補（内容の管轄裁定）。
 */
export type ProvisionalRecoveryClass =
  | 'raw-adjudication'
  | 'interpretation'
  | 'envelope'
  | 'action'
  | 'terminal-adjudication';

export function adjudicationAttemptsExhausted(provisional: FindingProvisionalMetadata): boolean {
  return (provisional.adjudicationAttempts ?? []).length >= MANAGER_ADJUDICATION_LIMITS.maxReplayAttempts;
}

export function classifyProvisionalRecovery(provisional: FindingProvisionalMetadata): ProvisionalRecoveryClass {
  switch (provisional.kind) {
    case 'unverified-locationless':
      // locationless は機械検証も replay も成立しない主張 — 最初から管轄裁定。
      return 'terminal-adjudication';
    case 'raw-meaning-ambiguous':
      // ladder 由来（epochs >= 1）は解釈の前進が出口。epochs === 0 は WAL の
      // lineage を持たない legacy な裁定未了（旧バイナリの rejection /
      // unsupported / unmentioned / stale 経路）— raw-adjudication-unresolved と
      // 同じ扱い。stableKey は kind を含むため kind の migration はしない
      // （resume 互換: 同一 claim の別 stableKey 再着地で settlement の一意対応が
      // 壊れる）。
      if (provisional.interpretationEpochs >= MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage) {
        return 'terminal-adjudication';
      }
      if (provisional.interpretationEpochs === 0) {
        return adjudicationAttemptsExhausted(provisional) ? 'terminal-adjudication' : 'raw-adjudication';
      }
      return 'interpretation';
    case 'raw-adjudication-unresolved':
    case 'manager-output-discarded':
      return adjudicationAttemptsExhausted(provisional) ? 'terminal-adjudication' : 'raw-adjudication';
    case 'manager-budget-exhausted':
    case 'interpretation-interrupted':
      return 'interpretation';
    case 'reviewer-output-overflow':
      return 'envelope';
    case 'stale-precondition':
      // 保存済み source raw があれば再裁定できる。無い stale（invalidate /
      // waive / duplicate / dismiss の action 系）は対象状態の充足で機械 resolve。
      if (provisional.sourceRawFindingIds.length > 0) {
        return adjudicationAttemptsExhausted(provisional) ? 'terminal-adjudication' : 'raw-adjudication';
      }
      return 'action';
    case 'invalid-location-evidence':
      // legacy kind（新規生成なし）。replay 材料も機械検証経路も無いため、
      // 読み取り互換で残っている個体は管轄裁定で閉じられるようにする。
      return 'terminal-adjudication';
  }
}

export function isOpenProvisional(
  finding: FindingLedgerEntry,
): finding is FindingLedgerEntry & { provisional: FindingProvisionalMetadata } {
  return finding.status === 'open' && finding.provisional !== undefined;
}
