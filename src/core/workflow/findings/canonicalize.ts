import type { FindingManagerConflict, FindingManagerOutput } from './types.js';

/**
 * 同じ finding に「まだ在る」証拠（matches / conflicts）と「直った」(resolvedFindings)
 * が同時に付いた出力を、矛盾を保ったまま台帳へ書ける形へ畳む。
 *
 * どちらもレビュアーの正当な観測で、矛盾は現実の側にある（部分的にしか直っていない）。
 * 実測（takt-bench v3-r2）: 台帳 F-0002（同期 FS 操作 @ :137）の修正確認と、同じ
 * familyTag の残存指摘（@ :149）が同一ラウンドで届いた。
 *
 * 畳まないと「1 finding = 1 決定」の不変条件違反として出力全体が捨てられ、台帳が
 * 更新されないまま reviewers ↔ fix が永久に回る。未修正の証拠（match または conflict）
 * を優先して open に留め、修正確認は conflict として記録する（manager 指示の
 * 「迷ったら open を維持」と同じ向き）。conflict 側を対象に含めるのは、reviewer の
 * 再観測が conflict の形で既に記録されている場合も同じ矛盾だから
 * （「未修正の証拠がある finding は resolved にしない」が不変条件）。
 *
 * 適用箇所は2つある。組み立て直後（LLM の判断が衝突した場合）と、機械分類の結果と
 * merge した直後（実測の障害はこちら。resolution_confirmation は機械分類が処理する
 * ため、LLM の組み立てには現れず、衝突は merge で初めて生まれる）。
 */
export function canonicalizeFindingManagerOutput(output: FindingManagerOutput): FindingManagerOutput {
  const collidingFindingIds = new Set([
    ...output.matches.map((match) => match.findingId),
    ...output.conflicts.flatMap((conflict) => conflict.findingIds),
  ]);
  const colliding = output.resolvedFindings.filter((resolved) => collidingFindingIds.has(resolved.findingId));
  if (colliding.length === 0) {
    return output;
  }

  const conflicts: FindingManagerConflict[] = [...output.conflicts];
  for (const resolved of colliding) {
    const existingIndex = conflicts.findIndex(
      (conflict) => conflict.findingIds.length === 1 && conflict.findingIds[0] === resolved.findingId,
    );
    const existing = existingIndex === -1 ? undefined : conflicts[existingIndex];
    if (existing === undefined) {
      conflicts.push({
        findingIds: [resolved.findingId],
        rawFindingIds: [...resolved.rawFindingIds],
        description: `Resolution confirmation conflicts with evidence that finding "${resolved.findingId}" still persists in the same round`,
      });
      continue;
    }
    conflicts[existingIndex] = {
      ...existing,
      rawFindingIds: [...new Set([...existing.rawFindingIds, ...resolved.rawFindingIds])],
    };
  }

  return {
    ...output,
    resolvedFindings: output.resolvedFindings.filter((resolved) => !collidingFindingIds.has(resolved.findingId)),
    conflicts,
  };
}
