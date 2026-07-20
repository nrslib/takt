import type { FindingLedger, FindingManagerOutput } from './types.js';

export function collectActiveConflictFindingIds(ledger: FindingLedger): Set<string> {
  return new Set(
    ledger.conflicts
      .filter((conflict) => conflict.status === 'active')
      .flatMap((conflict) => conflict.findingIds),
  );
}

export interface RejectedDuplicateNormalization {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  reason: string;
}

export interface NormalizedManagerPlan {
  output: FindingManagerOutput;
  rejectedDuplicateDecisions: RejectedDuplicateNormalization[];
}

/**
 * 重複統合と同ラウンド証拠の衝突を決定的に解消する最終正規化。
 *
 * ALLOWED_DECISION_PAIRS は matches|supersededFindings / conflicts|supersededFindings
 * を許可しない。しかし「重複 finding が同ラウンドで再観測される」のはレビュアーが
 * 重複を再報告する以上必然の組合せで、LLM に併記回避を指示して防ぐものではない。
 * ここで engine が正規化する:
 *
 * - conflict（この出力の conflicts / 台帳の active conflict）が canonical または
 *   duplicate に触れる duplicateDecision は不採用にする — conflict の identity は
 *   裁定（adjudication）経路の管轄であり、統合で集約を変えない。
 * - 残った統合について、superseded になる finding への match を canonical へ
 *   付け替える — 統合とは「同じ問題の観測を1つの finding へ束ねる」ことなので、
 *   duplicate への再観測は canonical の観測そのもの。
 *
 * 純関数かつ冪等: 付け替え後の出力に superseded を指す match は存在せず、
 * 再適用しても変化しない。
 */
export function normalizeManagerPlan(input: {
  output: FindingManagerOutput;
  /** 台帳上の active conflict が参照する finding id（保存時は fresh ledger 起点で渡す）。 */
  activeConflictFindingIds: ReadonlySet<string>;
}): NormalizedManagerPlan {
  const { output } = input;
  if (output.duplicateFindings.length === 0) {
    return { output, rejectedDuplicateDecisions: [] };
  }

  const conflictTouchedFindingIds = new Set([
    ...input.activeConflictFindingIds,
    ...output.conflicts.flatMap((conflict) => conflict.findingIds),
  ]);

  const rejectedDuplicateDecisions: RejectedDuplicateNormalization[] = [];
  const acceptedDuplicates = output.duplicateFindings.filter((duplicate) => {
    const touched = [duplicate.canonicalFindingId, ...duplicate.duplicateFindingIds]
      .filter((findingId) => conflictTouchedFindingIds.has(findingId));
    if (touched.length === 0) {
      return true;
    }
    rejectedDuplicateDecisions.push({
      canonicalFindingId: duplicate.canonicalFindingId,
      duplicateFindingIds: [...duplicate.duplicateFindingIds],
      reason: `Cannot supersede while a conflict references ${touched.map((findingId) => `"${findingId}"`).join(', ')}; adjudicate the conflict first`,
    });
    return false;
  });

  const canonicalBySuperseded = new Map(acceptedDuplicates.flatMap((duplicate) => (
    duplicate.duplicateFindingIds.map((findingId) => [findingId, duplicate.canonicalFindingId] as const)
  )));
  if (canonicalBySuperseded.size === 0 && rejectedDuplicateDecisions.length === 0) {
    return { output, rejectedDuplicateDecisions: [] };
  }

  const matches = transferMatchesToCanonical(output.matches, canonicalBySuperseded);
  return {
    output: { ...output, matches, duplicateFindings: acceptedDuplicates },
    rejectedDuplicateDecisions,
  };
}

function transferMatchesToCanonical(
  matches: FindingManagerOutput['matches'],
  canonicalBySuperseded: ReadonlyMap<string, string>,
): FindingManagerOutput['matches'] {
  if (matches.every((match) => !canonicalBySuperseded.has(match.findingId))) {
    return matches;
  }
  const transferred: FindingManagerOutput['matches'] = [];
  const indexByFindingId = new Map<string, number>();
  for (const match of matches) {
    const targetFindingId = canonicalBySuperseded.get(match.findingId) ?? match.findingId;
    const existingIndex = indexByFindingId.get(targetFindingId);
    if (existingIndex === undefined) {
      indexByFindingId.set(targetFindingId, transferred.length);
      transferred.push({ ...match, findingId: targetFindingId, rawFindingIds: [...match.rawFindingIds] });
      continue;
    }
    const existing = transferred[existingIndex]!;
    transferred[existingIndex] = {
      ...existing,
      rawFindingIds: [...new Set([...existing.rawFindingIds, ...match.rawFindingIds])],
    };
  }
  return transferred;
}
