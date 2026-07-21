/**
 * provisional fixpoint 判定。意味を確定できない raw finding は provisional
 * として台帳に着地し COMPLETE を塞ぐが、幻覚など「レビュアーが何度観測しても
 * 解消しない」provisional は plan への差し戻しを無限に繰り返す（安全だが
 * 有限時間で停止しない）。ここでは「直前ラウンドと今ラウンドで台帳の意味的な
 * 状態に変化が無い」ことを機械判定し、workflow がその結果を見て
 * NEEDS_ADJUDICATION（要人手裁定の終端状態）へルーティングできるようにする。
 *
 * ラウンド跨ぎの比較状態は FindingLedger.fixpoint フィールドへ永続化する
 * （エンジンの LoopDetector/CycleDetector はエンジンインスタンスごとに
 * 再構築され resume を跨げないため、この比較には使えない）。ledger は
 * run/resume を跨いで永続化されるため、resume 後の新しいラウンドも
 * このモジュールだけで前ラウンドとの比較を継続できる。
 */
import { computeConflictEvidenceHash, isLedgerConflictUnadjudicated } from './adjudication-evidence.js';
import { computeReviewScopeSnapshotId } from './snapshot.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import { REVIEWER_ENVELOPE_RECOVERY_LIMITS } from './raw-finding-limits.js';
import type { FindingLedger, FindingLedgerFixpointSnapshot, FindingLedgerFixpointState } from './types.js';

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function provisionalFixpointKey(
  finding: FindingLedger['findings'][number] & { provisional: NonNullable<FindingLedger['findings'][number]['provisional']> },
  roundsCompleted: number,
): string {
  const provisional = finding.provisional;
  const envelopeRounds = provisional.kind === 'reviewer-output-overflow'
    && provisional.firstObservedRound !== undefined
    ? Math.min(
        REVIEWER_ENVELOPE_RECOVERY_LIMITS.maxUnavailableRounds,
        Math.max(0, roundsCompleted - provisional.firstObservedRound + 1),
      )
    : 0;
  const progress = [
    provisional.interpretationEpochs,
    provisional.adjudicationAttempts?.length ?? 0,
    provisional.actionRecoveryAttempts?.length ?? 0,
    envelopeRounds,
  ];
  return progress.every((value) => value === 0)
    ? provisional.stableKey
    : `${provisional.stableKey}:recovery:${progress.join(':')}`;
}

/**
 * ledger の現時点の状態から fixpoint 比較用スナップショットを計算する。
 * 3つの独立した基準（「新しい admissible evidence が
 * 無い」は、findingId が単調増加で再利用されないため id 込みの
 * substantiveEntries / unadjudicatedConflictEntries の変化として現れる —
 * 新規 finding・resolve・reopen・waive・invalidate は必ずどれかの集合の
 * 要素を変える）。
 */
export function computeFixpointSnapshot(ledger: FindingLedger, cwd: string): FindingLedgerFixpointSnapshot {
  const roundsCompleted = stopBudgetRoundsCompleted(ledger);
  const provisionalKeys = sortedUnique(
    ledger.findings
      .filter((finding): finding is FindingLedger['findings'][number] & {
        provisional: NonNullable<FindingLedger['findings'][number]['provisional']>;
      } => finding.status === 'open' && finding.provisional !== undefined)
      .map((finding) => provisionalFixpointKey(finding, roundsCompleted)),
  );

  // 終端した provisional（dismissed 等）も id:status で含める: provisionalKeys
  // からは消えるが、終端という状態変化そのものをスナップショット差分として
  // 監査可能にする（dismiss 直後のラウンドが「変化なし」と誤判定されない）。
  const substantiveEntries = sortedUnique(
    ledger.findings
      .filter((finding) => finding.provisional === undefined || finding.status !== 'open')
      .map((finding) => `${finding.id}:${finding.status}`),
  );

  const activeConflicts = ledger.conflicts.filter((conflict) => conflict.status === 'active');
  let unadjudicatedConflictEntries: string[] = [];
  if (activeConflicts.length > 0) {
    const reviewScopeSnapshotId = computeReviewScopeSnapshotId(cwd);
    unadjudicatedConflictEntries = sortedUnique(
      activeConflicts
        .filter((conflict) => isLedgerConflictUnadjudicated(conflict, ledger, reviewScopeSnapshotId))
        .map((conflict) => `${conflict.id}:${computeConflictEvidenceHash(conflict, ledger, reviewScopeSnapshotId)}`),
    );
  }

  return { provisionalKeys, substantiveEntries, unadjudicatedConflictEntries };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function snapshotsEqual(a: FindingLedgerFixpointSnapshot, b: FindingLedgerFixpointSnapshot): boolean {
  return arraysEqual(a.provisionalKeys, b.provisionalKeys)
    && arraysEqual(a.substantiveEntries, b.substantiveEntries)
    && arraysEqual(a.unadjudicatedConflictEntries, b.unadjudicatedConflictEntries);
}

/**
 * 今ラウンド終了時点の nextLedger に、fixpoint 比較結果を付与した ledger を返す。
 * 比較対象は previousLedger.fixpoint（このラウンド開始前 = 直前ラウンド終了時点
 * のスナップショット）。前スナップショットが無ければ（このラウンドが台帳にとって
 * 最初の比較対象ラウンド）reached は常に false — 初回や変化のあるラウンドは
 * 従来どおり plan へ差し戻す、という設計上の要請を満たす。
 *
 * 呼び出し元（manager-runner.ts）は findings-manager の1ラウンド分の reconcile
 * が終わった最終 ledger を nextLedger として渡す。previousLedger には
 * updateLedger の排他区間で読み直した fresh ledger（このラウンド開始直前の
 * 最新永続化状態）を渡すこと — lost-update を避けるため、関数呼び出し開始時に
 * 一度だけ読んだ previousLedger 変数を使ってはいけない。
 */
export function attachFixpointState(previousLedger: FindingLedger, nextLedger: FindingLedger, cwd: string): FindingLedger {
  const snapshot = computeFixpointSnapshot(nextLedger, cwd);
  const previousSnapshot = previousLedger.fixpoint?.snapshot;
  const reached = previousSnapshot !== undefined
    && snapshot.provisionalKeys.length > 0
    && snapshotsEqual(previousSnapshot, snapshot);
  const fixpoint: FindingLedgerFixpointState = { snapshot, reached };
  return { ...nextLedger, fixpoint };
}
