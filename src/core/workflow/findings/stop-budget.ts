/**
 * 有限停止予算（bounded stop budget）。
 *
 * fixpoint 判定（fixpoint.ts）は「provisional 集合が前ラウンドと意味的に
 * 変化していない」ことを機械判定するが、レビュアー（弱いローカルモデル）が
 * 毎ラウンド別の架空 provisional を1件でも生成し続けると、provisional 集合が
 * 毎回変化し続けて fixpoint が永久に成立しない（存在しないファイルを
 * 引用した架空 provisional が churn し続け、resolved は進むが provisional も
 * 湧き続けて iteration 上限まで終端に達しない）。
 *
 * ここでは「findings-manager の完了ラウンド数（と任意で経過時間）が設定上限を
 * 超えたら、provisional が churn し続けていても NEEDS_ADJUDICATION へ収束させる」
 * というモデル挙動に依存しない停止条件を追加する。fixpoint と同じく、ラウンド
 * 跨ぎの累積状態は FindingLedger.stopBudget フィールドへ永続化する（run/resume を
 * 跨いだ累積が無料で成立する）。
 */
import type { FindingContractStopBudgetConfig, FindingLedger, FindingLedgerStopBudgetState } from './types.js';
import { rfc3339TimelineMilliseconds } from '../../models/rfc3339.js';
import { addRoundMarker } from './round-marker.js';

/**
 * finding_contract.stop_budget が省略した（または一部だけ省略した）フィールドを
 * 補う既定値。「無制限を許さない」設計要請を満たすため、workflow が
 * stop_budget を一切書かなくても有限ラウンドで停止する。長時間継続する
 * provisional churn を大きく下回る値を既定にする。
 *
 * 時間上限（max_minutes）に既定値は置かない。守るべき病理（churn）はラウンド数に
 * 現れるのであって時間には現れず、時間の既定上限は「ラウンドは少ないが 1 ラウンドが
 * 重い健全な大型 run」を誤って停止させた実測がある（2026-07-20 の PR #1017 再走:
 * 11/40 ラウンドで収束中に旧既定 90 分側が発火）。壁時計上限が必要なケース
 * （夜間ベンチ等）だけが max_minutes を明示設定する。
 */
export const DEFAULT_STOP_BUDGET = Object.freeze({
  /** findings-manager の完了ラウンド数の上限。 */
  maxRounds: 40,
});

export interface ResolvedStopBudgetLimits {
  maxRounds: number;
  /** 未設定なら時間上限なし（ラウンド上限のみで停止を保証する）。 */
  maxMinutes: number | undefined;
}

/** 設定値（省略可）と既定値を合成する。この関数だけが既定値適用の唯一の場所。 */
export function resolveStopBudgetLimits(
  configured: FindingContractStopBudgetConfig | undefined,
): ResolvedStopBudgetLimits {
  return {
    maxRounds: configured?.maxRounds ?? DEFAULT_STOP_BUDGET.maxRounds,
    maxMinutes: configured?.maxMinutes,
  };
}

function elapsedMinutes(firstRoundAt: string, nowIso: string): number {
  return (rfc3339TimelineMilliseconds(nowIso) - rfc3339TimelineMilliseconds(firstRoundAt)) / 60_000;
}

/** roundMarkers.length から導出する完了ラウンド数。読み取り側の唯一の入口。 */
export function stopBudgetRoundsCompleted(ledger: FindingLedger): number {
  return ledger.stopBudget?.roundMarkers.length ?? 0;
}

/**
 * 今ラウンド終了時点の nextLedger に、有限停止予算の消費状況を付与した ledger を
 * 返す。呼び出し元（manager-runner.ts）は findings-manager の1ラウンド分の
 * reconcile が終わった最終 ledger を nextLedger として渡す。previousLedger には
 * attachFixpointState と同じく、updateLedger の排他区間で読み直した fresh ledger
 * （このラウンド開始直前の最新永続化状態）を渡すこと。
 *
 * ラウンド計上は「このラウンドの一意マーカーを適用済み集合へ追記する」形にする
 * （interpretation-wal.ts の ledger_applied 集合と同じ冪等機構）— crash/replay で
 * 同一 invocation の更新が二度コミットされても Set の重複追加は no-op になり、
 * roundsCompleted（= 集合サイズ）は二重計上・巻き戻りしない。進捗（resolved の
 * 増加等）ではマーカーは変わらないため、予算は単調累積のみ。firstRoundAt は
 * 最初のラウンドで一度だけ確定し、以降は上書きしない。
 */
export function attachStopBudgetState(
  previousLedger: FindingLedger,
  nextLedger: FindingLedger,
  limits: ResolvedStopBudgetLimits,
  roundMarker: string,
  nowIso: string,
): FindingLedger {
  const roundMarkers = addRoundMarker(previousLedger.stopBudget?.roundMarkers, roundMarker);
  const firstRoundAt = previousLedger.stopBudget?.firstRoundAt ?? nowIso;
  const exhausted = roundMarkers.length >= limits.maxRounds
    || (limits.maxMinutes !== undefined && elapsedMinutes(firstRoundAt, nowIso) >= limits.maxMinutes);
  const stopBudget: FindingLedgerStopBudgetState = { roundMarkers, firstRoundAt, exhausted };
  return { ...nextLedger, stopBudget };
}
