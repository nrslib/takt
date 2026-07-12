/**
 * 二系統台帳（codex 対策#4: typed evidence protocol + verbatimExcerpt 機械照合 +
 * 二系統台帳 + gate 分離）の review-integrity 側の台帳操作。
 *
 * product finding（FindingLedgerEntry、findings 配列）とは完全に独立した配列
 * （reviewerAnomalies）へ隔離する。安全不変条件（設計書 D、すべてこのモジュール
 * だけで守る）:
 *   - invalidated/resolved/waived として扱わない（ReviewerAnomalyEntry に
 *     そもそもそういう状態フィールドが無い — 型で保証）
 *   - 既存 finding の状態・revision・evidence hash を変更しない（別配列を返す
 *     だけで、呼び出し元は findings 配列に一切触れない）
 *   - 観測を削除・改変しない（upsert は追記専用 — occurrences を増やし
 *     lastObserved/最新の claim を更新するだけで、既存レコードを消さない）
 *   - 「引用が違うので問題は存在しない」と記録しない（mismatchReason は
 *     「証拠が不成立」の事実だけを記述する契約 — 呼び出し元の責務）
 */
import { createHash } from 'node:crypto';
import type {
  FindingLedger,
  FindingReconcileContext,
  ReviewerAnomalyEntry,
  ReviewerAnomalyKind,
} from './types.js';

export interface ReviewerAnomalySpec {
  kind: ReviewerAnomalyKind;
  stableKey: string;
  lineageKey: string;
  sourceRawFindingIds: string[];
  reviewers: string[];
  title: string;
  claimedLocation?: string;
  claimedExcerpt?: string;
  mismatchReason: string;
}

/**
 * 決定的・内容アドレス方式の id（reconciler.ts の formatConflictId と同じ発想:
 * LLM が id を採番・参照することは無い — reviewer anomaly は product finding と
 * 違い、どの LLM にも id を返させないため、F-XXXX のような密な連番カウンタは
 * 不要）。同じ stableKey は常に同じ id になるため、upsert が id 割当を
 * 意識しなくてよい。
 */
function formatReviewerAnomalyId(stableKey: string): string {
  return `RA-${createHash('sha256').update(stableKey).digest('hex').slice(0, 12).toUpperCase()}`;
}

function mergeUnique(current: readonly string[], next: readonly string[]): string[] {
  return Array.from(new Set([...current, ...next]));
}

/**
 * reviewer anomaly spec を台帳へ追記適用する（upsert by stableKey）。
 * provisional の applyProvisionalFindingSpecs（reconciler.ts）と同じ「同じ
 * stableKey が既にあれば更新、無ければ新規」則だが、意図的に別実装にしている —
 * 対象レコード型（ReviewerAnomalyEntry には status/lifecycle/revision/waivers が
 * 無く、gate-blocking の概念も無い）も安全不変条件（既存 finding 側は一切
 * 触らない）もドメインとして別物であり、無理に共通化すると「product finding の
 * upsert 則」と「review-integrity の upsert 則」の差分が読みにくくなる。
 */
export function applyReviewerAnomalySpecsToLedger(
  ledger: FindingLedger,
  specs: readonly ReviewerAnomalySpec[],
  context: FindingReconcileContext,
): FindingLedger {
  if (specs.length === 0) {
    return ledger;
  }
  const observation = { runId: context.runId, stepName: context.stepName, timestamp: context.timestamp };
  const byStableKey = new Map<string, ReviewerAnomalyEntry>(
    (ledger.reviewerAnomalies ?? []).map((entry) => [entry.stableKey, entry]),
  );

  for (const spec of specs) {
    const existing = byStableKey.get(spec.stableKey);
    if (existing !== undefined) {
      // crash/replay 冪等（codex 検証ブロッカー#3）: occurrences は「観測された
      // 回数」なので、同一 raw finding id の再適用（同一ラウンドが二度コミット
      // される crash/replay）で二重計上してはならない。stop budget の round
      // marker（適用済みマーカー集合）と同じ思想で、適用済みの raw finding id を
      // 冪等判定キーにする — 今回の spec が既存に無い新しい raw finding id を
      // 1件も持ち込まないなら、それは既適用の再来なので完全な no-op にする
      // （occurrences も lastObserved も mismatchReason も動かさない）。別ラウンドの
      // 再観測は名前空間付き raw finding id（runId:step:iter:reviewer:localId）が
      // 必ず異なるため新規 id として現れ、正しく +1 される。
      const bringsNewObservation = spec.sourceRawFindingIds.some(
        (id) => !existing.sourceRawFindingIds.includes(id),
      );
      if (!bringsNewObservation) {
        continue;
      }
      byStableKey.set(spec.stableKey, {
        ...existing,
        sourceRawFindingIds: mergeUnique(existing.sourceRawFindingIds, spec.sourceRawFindingIds),
        reviewers: mergeUnique(existing.reviewers, spec.reviewers),
        mismatchReason: spec.mismatchReason,
        lastObserved: observation,
        occurrences: existing.occurrences + 1,
        // 最新の claim を監査用に保持する（無ければ前回値を残す）。
        ...(spec.claimedLocation !== undefined ? { claimedLocation: spec.claimedLocation } : {}),
        ...(spec.claimedExcerpt !== undefined ? { claimedExcerpt: spec.claimedExcerpt } : {}),
      });
      continue;
    }
    byStableKey.set(spec.stableKey, {
      id: formatReviewerAnomalyId(spec.stableKey),
      kind: spec.kind,
      stableKey: spec.stableKey,
      lineageKey: spec.lineageKey,
      sourceRawFindingIds: [...spec.sourceRawFindingIds],
      reviewers: [...spec.reviewers],
      title: spec.title,
      ...(spec.claimedLocation !== undefined ? { claimedLocation: spec.claimedLocation } : {}),
      ...(spec.claimedExcerpt !== undefined ? { claimedExcerpt: spec.claimedExcerpt } : {}),
      mismatchReason: spec.mismatchReason,
      firstObserved: observation,
      lastObserved: observation,
      occurrences: 1,
    });
  }

  return { ...ledger, reviewerAnomalies: [...byStableKey.values()] };
}

export interface ReviewerAnomalyPromotionCandidate {
  /** 昇格判定に使う lineageKey（同一 claim の同定キー）。 */
  lineageKey: string;
  /** この raw を含む product finding を reconciled ledger から探すためのキー。 */
  rawFindingId: string;
}

/**
 * 後続ラウンドの clean な verbatimExcerpt 一致が product finding を確定させた
 * 場合に、同じ lineageKey を持つ未昇格の reviewer anomaly へ promotedFindingId を
 * 記録する（設計書 D:「後続ラウンドで一致する証跡が出たら初めて product finding
 * 側へ昇格できる」）。レコード自体は削除・改変しない — 昇格後も監査履歴として
 * 残る（観測消去の禁止）。呼び出し元は reconcile 完了後の最終 ledger（finding id
 * 割当済み）を渡すこと — このタイミングでしか「どの finding id に着地したか」が
 * 確定しない。
 */
export function linkPromotedReviewerAnomalies(
  ledger: FindingLedger,
  candidates: readonly ReviewerAnomalyPromotionCandidate[],
): FindingLedger {
  const anomalies = ledger.reviewerAnomalies;
  if (anomalies === undefined || anomalies.length === 0 || candidates.length === 0) {
    return ledger;
  }
  const findingIdByRawFindingId = new Map<string, string>();
  for (const finding of ledger.findings) {
    for (const rawFindingId of finding.rawFindingIds) {
      findingIdByRawFindingId.set(rawFindingId, finding.id);
    }
  }
  const promotedFindingIdByLineageKey = new Map<string, string>();
  for (const candidate of candidates) {
    const findingId = findingIdByRawFindingId.get(candidate.rawFindingId);
    if (findingId !== undefined) {
      promotedFindingIdByLineageKey.set(candidate.lineageKey, findingId);
    }
  }
  if (promotedFindingIdByLineageKey.size === 0) {
    return ledger;
  }
  const updated = anomalies.map((anomaly) => {
    if (anomaly.promotedFindingId !== undefined) {
      return anomaly;
    }
    const promotedFindingId = promotedFindingIdByLineageKey.get(anomaly.lineageKey);
    return promotedFindingId === undefined ? anomaly : { ...anomaly, promotedFindingId };
  });
  return { ...ledger, reviewerAnomalies: updated };
}
