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
 * NEEDS_ADJUDICATION へルーティングする（fixpoint/停止予算と同じ「有限で人手裁定へ」
 * の最終防波堤）。
 *
 * ラウンド跨ぎの累積状態は FindingLedger.reviewIntegrity へ永続化する（run/resume を
 * 跨いだ累積が無料で成立する）。マーカーの一意性・冪等性は round-marker.ts の
 * computeRoundMarker を共有する。
 */
import type {
  FindingContractReviewBudgetConfig,
  FindingLedger,
  FindingLedgerReviewIntegrityState,
} from './types.js';
import { addRoundMarker } from './round-marker.js';

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

/** 未昇格（promotedFindingId 無し）の reviewer anomaly が1件でも残っているか。 */
function hasOutstandingReviewerAnomalies(ledger: FindingLedger): boolean {
  return (ledger.reviewerAnomalies ?? []).some((anomaly) => anomaly.promotedFindingId === undefined);
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
