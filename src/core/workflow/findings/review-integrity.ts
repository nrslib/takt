/**
 * review-integrity 予算（review-integrity requirement）。
 *
 * 二系統台帳（review-integrity protocol）は、機械照合を通らない reviewer の主張を product
 * finding ではなく reviewer anomaly（review-integrity 側）へ隔離する。だが「全
 * 指摘が anomaly に隔離された run」は product gate（open/provisional）が空になり、
 * ワークフローが即 COMPLETE へ流れて実質レビューされずに通り得た。これを防ぐため、
 * 未昇格（promotedFindingId 無し）の anomaly が残る限り product gate とは別の
 * review-integrity gate が COMPLETE を拒否し、再レビューへ送る。
 *
 * その再レビューを無限に繰り返さないための有限予算がこのモジュール。stop budget
 * と同じ round-marker 方式（適用済みマーカー集合。crash/replay 冪等）で、「未昇格
 * anomaly が残ったまま完了した findings-manager ラウンド」を数える。上限に達したら
 * exhausted=true になり、builtin は再レビュー（reviewers）ではなく
 * 要件を維持した再計画へルーティングする。反復の有限停止は loop monitor が担う。
 *
 * ラウンド跨ぎの累積状態は FindingLedger.reviewIntegrity へ永続化する（run/resume を
 * 跨いだ累積が無料で成立する）。マーカーの一意性・冪等性は round-marker.ts の
 * computeRoundMarker を共有する。
 */
import type {
  FindingContractReviewBudgetConfig,
  FindingLedger,
  FindingLedgerReviewIntegrityState,
  ReviewerAnomalyEntry,
} from './types.js';
import { addRoundMarker } from './round-marker.js';
import { isOutstandingReviewerAnomaly } from './reviewer-anomalies.js';
import {
  isConcludedReviewerAnomaly,
} from '../../models/finding-reviewer-anomaly-settlement-policy.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

/**
 * finding_contract.review_budget が省略した場合の既定値。「無制限を許さない」
 * 設計要請を満たすため、workflow が review_budget を一切書かなくても有限回の
 * 再レビューで停止する。reviewers と final-gate の双方が findings-manager を
 * 走らせ得るため、1 レビューサイクルで複数マーカーが付く場合がある — 数サイクル
 * 分の再レビュー機会を残しつつ、壊れたレビュアーの無駄な反復は抑える値にする。
 */
export const DEFAULT_REVIEW_INTEGRITY_BUDGET = Object.freeze({
  maxReviewRounds: 6,
});

export interface ResolvedReviewIntegrityLimits {
  maxReviewRounds: number;
}

/** 設定値（省略可）と既定値を合成する。この関数だけが既定値適用の唯一の場所。 */
export function resolveReviewIntegrityLimits(
  configured: FindingContractReviewBudgetConfig | undefined,
): ResolvedReviewIntegrityLimits {
  return {
    maxReviewRounds: configured?.maxReviewRounds ?? DEFAULT_REVIEW_INTEGRITY_BUDGET.maxReviewRounds,
  };
}

/** roundMarkers.length から導出する完了ラウンド数。読み取り側の唯一の入口。 */
export function reviewIntegrityRoundsCompleted(ledger: FindingLedger): number {
  return ledger.reviewIntegrity?.roundMarkers.length ?? 0;
}

/** 未昇格かつ未settleの reviewer anomaly が1件でも残っているか。 */
function hasOutstandingReviewerAnomalies(ledger: FindingLedger): boolean {
  return (ledger.reviewerAnomalies ?? []).some(isOutstandingReviewerAnomaly);
}

export type IntakeReviewIntegrityFailureCode =
  | 'review_integrity_unresolved_unpresented'
  | 'restatement_exhausted_claim_bearing';

export interface IntakeReviewIntegrityFailureClassification {
  readonly code: IntakeReviewIntegrityFailureCode;
  readonly reason: string;
  readonly anomalyIds: string[];
  readonly unpresentedIds: string[];
  readonly classificationAuthorityIds: string[];
}

/**
 * 完了直前の review-integrity ゲートが、残った intake anomaly をどう診断するか。
 *
 * 2つの原因を区別する:
 *   - `unpresented`: 言い直しの機会が一度も与えられていない（ワークフローの配線漏れ）
 *   - `exhausted`: 提示ラダーが終わり、終端処分として決着している（可視的失敗）
 *
 * 終端処分済み（intakeContract.terminalDisposition あり）は unpresented の対象から
 * 外す。提示回数は終端処分の判定材料であって、決着後の診断材料ではない —
 * `undemandable_claim_atom` は提示を1回も行わずに終端する正規の kind なので、
 * 提示回数をどう数え直しても「提示されていない」は真にならない。ここで外さないと、
 * 決着済みの anomaly が常に配線漏れとして報告され、診断が原因を指さなくなる。
 *
 * 純関数。提示回数の収集（IO）は呼び出し側が行う。
 */
export function classifyIntakeReviewIntegrityFailure(input: {
  /** 未決着の reviewer anomaly（isOutstandingReviewerAnomaly で絞り込み済み）。 */
  readonly anomalies: readonly ReviewerAnomalyEntry[];
  readonly presentationCounts: ReadonlyMap<string, number>;
}): IntakeReviewIntegrityFailureClassification | undefined {
  const intakeAnomalies = input.anomalies.filter((anomaly) => (
    anomaly.kind === 'intake-contract-incomplete'
    && anomaly.intakeContract !== undefined
  ));
  if (intakeAnomalies.length === 0) {
    return undefined;
  }
  const unpresentedIds = intakeAnomalies
    .filter((anomaly) => (
      !isConcludedReviewerAnomaly(anomaly)
      && (input.presentationCounts.get(anomaly.id) ?? 0) === 0
    ))
    .map(({ id }) => id)
    .sort(compareBinaryStrings);
  const exhaustedIds = intakeAnomalies
    .filter((anomaly) => (
      anomaly.intakeContract!.terminalDisposition?.workflowOutcome === 'review_integrity_unresolved'
      || (anomaly.intakeContract!.observationClass === 'claim-bearing'
        && (input.presentationCounts.get(anomaly.id) ?? 0) >= anomaly.intakeContract!.presentationLimit)
    ))
    .map(({ id }) => id)
    .sort(compareBinaryStrings);
  if (unpresentedIds.length === 0 && exhaustedIds.length === 0) {
    return undefined;
  }
  const code: IntakeReviewIntegrityFailureCode = unpresentedIds.length > 0
    ? 'review_integrity_unresolved_unpresented'
    : 'restatement_exhausted_claim_bearing';
  return {
    code,
    reason: code === 'review_integrity_unresolved_unpresented'
      ? `Review-integrity reviewer anomaly restatement could not be presented for anomaly IDs: ${unpresentedIds.join(', ')}`
      : `Review-integrity reviewer anomaly restatement limit was exhausted for anomaly IDs: ${exhaustedIds.join(', ')}`,
    anomalyIds: intakeAnomalies.map(({ id }) => id).sort(compareBinaryStrings),
    unpresentedIds,
    classificationAuthorityIds: [...new Set(intakeAnomalies.map(
      ({ intakeContract }) => intakeContract!.classificationAuthorityId,
    ))].sort(compareBinaryStrings),
  };
}

/**
 * 今ラウンド終了時点の nextLedger に review-integrity 予算の消費状況を付与する。
 * stop budget と同じく、previousLedger には updateLedger の排他区間で読み直した
 * fresh ledger（このラウンド開始直前の最新永続化状態）を渡すこと。
 *
 * マーカーは「未昇格 anomaly が残ったまま完了したラウンド」にのみ付ける — 今
 * ラウンドで anomaly が1件も残っていなければ（promote/解消済み、あるいはそもそも
 * 出ていない）予算は消費しない。既存の予算状態は据え置く（後続ラウンドで anomaly が
 * 再来したら続きから数える。stop budget と同じ単調累積・巻き戻りなし）。
 */
/**
 * 予算へ計上しないラウンド（言い直し slot の各パス）の据え置き。attachStopBudgetState
 * 側と同じ理由で、reconcile 後の nextLedger へ累積状態を明示的に戻す。
 */
export function carryReviewIntegrityState(
  previousLedger: FindingLedger,
  nextLedger: FindingLedger,
): FindingLedger {
  return previousLedger.reviewIntegrity === undefined
    ? nextLedger
    : { ...nextLedger, reviewIntegrity: previousLedger.reviewIntegrity };
}

export function attachReviewIntegrityState(
  previousLedger: FindingLedger,
  nextLedger: FindingLedger,
  limits: ResolvedReviewIntegrityLimits,
  roundMarker: string,
  nowIso: string,
): FindingLedger {
  const priorState = previousLedger.reviewIntegrity;
  if (!hasOutstandingReviewerAnomalies(nextLedger)) {
    // 未昇格 anomaly が残っていないラウンドは予算を消費しない。既存状態は
    // そのまま持ち越す（reconcile が作り直した nextLedger には prior state が
    // 乗っていないため、明示的に再付与する — stop budget と同じ理由）。
    return priorState !== undefined ? { ...nextLedger, reviewIntegrity: priorState } : nextLedger;
  }
  const roundMarkers = addRoundMarker(priorState?.roundMarkers, roundMarker);
  const firstRoundAt = priorState?.firstRoundAt ?? nowIso;
  const exhausted = roundMarkers.length >= limits.maxReviewRounds;
  const reviewIntegrity: FindingLedgerReviewIntegrityState = { roundMarkers, firstRoundAt, exhausted };
  return { ...nextLedger, reviewIntegrity };
}
