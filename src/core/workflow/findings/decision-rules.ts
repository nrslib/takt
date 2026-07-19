import type { FindingManagerOutput, FindingRecord } from './types.js';

/**
 * 1つの finding に付いた決定の組み合わせを検証する規則。
 *
 * 検証（manager-output-validation.ts）と適用（reconciler.ts）が同じ規則を使うために
 * ここへ集約する。片方だけ緩めると、検証を通った出力が適用で落ちる。
 *
 * 判定は finding ごとの Set<DecisionCategory> に対して全ペアを検査するため、
 * 決定の並び順に依存しない。
 */

export type DecisionCategory =
  | 'matches'
  | 'resolvedFindings'
  | 'reopenedFindings'
  | 'waivedFindings'
  | 'conflicts'
  | 'invalidatedFindings'
  | 'supersededFindings'
  | 'canonicalFindings';

/**
 * 同じ finding が2つの決定に現れてよい組み合わせ。
 *
 * - matches + conflicts: 修正確認と残存指摘が衝突していることを記録する経路。
 *   塞ぐと矛盾を台帳へ書けず、出力全体が捨てられて台帳が凍る。
 * - reopenedFindings + conflicts: closed だった finding の再発報告と、それと矛盾する
 *   修正確認が同じラウンドで届く場合。reopen して conflict を active にするのが安全で、
 *   open と conflict の両方がゲートを塞ぐためゲート開放の危険もない。
 *
 * finding を閉じる決定（resolvedFindings / waivedFindings）と conflicts の併存は許さない。
 * 閉じたまま conflict を active で残すと、conflict の裁定結果が finding の状態へ
 * 反映されないままゲートが開く。
 */
const ALLOWED_DECISION_PAIRS: ReadonlySet<string> = new Set([
  'conflicts|matches',
  'conflicts|reopenedFindings',
  'canonicalFindings|conflicts',
  'canonicalFindings|matches',
  'canonicalFindings|canonicalFindings',
]);

function pairKey(a: DecisionCategory, b: DecisionCategory): string {
  return [a, b].sort().join('|');
}

export function collectDecisionSets(
  managerOutput: FindingManagerOutput,
): Map<string, DecisionCategory[]> {
  const sets = new Map<string, DecisionCategory[]>();
  const add = (findingId: string, category: DecisionCategory): void => {
    const existing = sets.get(findingId);
    if (existing === undefined) {
      sets.set(findingId, [category]);
      return;
    }
    existing.push(category);
  };

  for (const match of managerOutput.matches) {
    add(match.findingId, 'matches');
  }
  for (const resolved of managerOutput.resolvedFindings) {
    add(resolved.findingId, 'resolvedFindings');
  }
  for (const reopened of managerOutput.reopenedFindings) {
    add(reopened.findingId, 'reopenedFindings');
  }
  for (const waived of managerOutput.waivedFindings) {
    add(waived.findingId, 'waivedFindings');
  }
  for (const conflict of managerOutput.conflicts) {
    for (const findingId of new Set(conflict.findingIds)) {
      add(findingId, 'conflicts');
    }
  }
  for (const invalidated of managerOutput.invalidatedFindings) {
    add(invalidated.findingId, 'invalidatedFindings');
  }
  // canonical は match/conflict との併存だけを許す。closed 遷移との併存を
  // 検出しないと、同一ラウンドで duplicate 統合した指摘を waive 等で閉じられる。
  for (const duplicate of managerOutput.duplicateFindings) {
    add(duplicate.canonicalFindingId, 'canonicalFindings');
    for (const findingId of new Set(duplicate.duplicateFindingIds)) {
      add(findingId, 'supersededFindings');
    }
  }
  return sets;
}

function validateDecisionCombination(findingId: string, categories: DecisionCategory[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < categories.length; i += 1) {
    for (let j = i + 1; j < categories.length; j += 1) {
      const a = categories[i]!;
      const b = categories[j]!;
      if (!ALLOWED_DECISION_PAIRS.has(pairKey(a, b))) {
        errors.push(`Finding id "${findingId}" appears in multiple manager decisions: ${a} and ${b}`);
      }
    }
  }
  return errors;
}

/**
 * closed（resolved / waived）な finding を active conflict が参照するなら、同じ出力で
 * reopen していなければならない。
 *
 * conflict だけを付けて finding を closed のまま残すと、`findings.open.count == 0` しか
 * 見ないワークフローではゲートが開く。builtin は conflicts も見るが、エンジンはその
 * 組み合わせを強制していない。
 */
function validateConflictStatusInvariant(
  managerOutput: FindingManagerOutput,
  previousFindingsById: ReadonlyMap<string, FindingRecord>,
): string[] {
  const reopenedFindingIds = new Set(managerOutput.reopenedFindings.map((reopened) => reopened.findingId));

  return managerOutput.conflicts.flatMap((conflict, index) => (
    [...new Set(conflict.findingIds)].flatMap((findingId) => {
      const previousStatus = previousFindingsById.get(findingId)?.status;
      if (previousStatus === undefined || previousStatus === 'open' || reopenedFindingIds.has(findingId)) {
        return [];
      }
      return [`conflicts[${index}] references finding "${findingId}" with status "${previousStatus}"; the same output must reopen it`];
    })
  ));
}

export function validateFindingDecisionSets(
  managerOutput: FindingManagerOutput,
  previousFindingsById: ReadonlyMap<string, FindingRecord>,
): string[] {
  const errors = [...collectDecisionSets(managerOutput)].flatMap(
    ([findingId, categories]) => validateDecisionCombination(findingId, categories),
  );
  return [...errors, ...validateConflictStatusInvariant(managerOutput, previousFindingsById)];
}
