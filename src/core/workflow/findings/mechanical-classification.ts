import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import { createEmptyManagerOutput } from './manager-output.js';
import type { FindingLedger, FindingManagerOutput, RawFinding } from './types.js';

/**
 * raw findings のうち、構造化フィールドの等価比較だけで分類が確定するものを
 * コードで処理し、判断が必要な残り（residual）だけを LLM manager に回すための
 * 機械分類。
 *
 * 保守的な原則: フィールド等価で一意に決まらないものは全て residual に落とす。
 * 機械的に確定してよいのは次の3つだけ:
 *   1. 完全同一の raw: 正規化後の title / description / path / suggestion が
 *      既存 open finding に紐づく raw finding のいずれかと全て一致する。
 *   2. 明示参照: relation が persists/reopened で targetFindingId が構造化
 *      フィールドとして与えられ、対象の状態が relation と整合する（persists は
 *      open、reopened は resolved/waived）場合だけ機械 same/reopen とする。
 *      状態が食い違う場合は raw 本文の意味矛盾を機械では検出できないため
 *      manager 送り。
 *   3. resolution_confirmation（現行どおり）: targetFindingId が open の
 *      指摘を指す場合のみ解消。
 *
 * familyTag + exact location による自動 same は削除した。familyTag と行番号は
 * 分類・検索ヒントに過ぎず、同一性の最終判断は manager（意味判断）に移る
 * 同じ familyTag・同じ行でも意味の異なる raw を混成 finding に畳まないためである。
 */
export interface MechanicalClassificationResult {
  output: FindingManagerOutput;
  residualRawFindings: RawFinding[];
}

/**
 * raw finding の relation を返す。現行契約では必須フィールドである。
 */
export function effectiveRawFindingRelation(raw: Pick<RawFinding, 'relation'>): RawFinding['relation'] {
  return raw.relation;
}

/** Exact-duplicate identity key for case 1: normalized (path, title, description, suggestion). Line number is deliberately excluded (evidence of current position, not identity). */
function exactDuplicateKey(raw: Pick<RawFinding, 'title' | 'description' | 'suggestion' | 'location'>): string {
  return JSON.stringify([
    parseFindingLocation(raw.location)?.path ?? '',
    normalizeFindingText(raw.title),
    normalizeFindingText(raw.description),
    raw.suggestion !== undefined ? normalizeFindingText(raw.suggestion) : '',
  ]);
}

/** Indexes every raw finding attached to an open ledger finding by its exact-duplicate key, for case-1 matching. */
function buildExactDuplicateIndex(
  ledger: FindingLedger,
  excludedFindingIds: ReadonlySet<string>,
): Map<string, string> {
  const rawById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const index = new Map<string, string>();
  for (const finding of ledger.findings) {
    if (finding.status !== 'open' || excludedFindingIds.has(finding.id)) {
      continue;
    }
    for (const rawFindingId of finding.rawFindingIds) {
      const raw = rawById.get(rawFindingId);
      if (raw === undefined) {
        continue;
      }
      const key = exactDuplicateKey(raw);
      // 複数の open finding が同じキーを持つのは通常あり得ない（あれば台帳側の
      // 既存の重複でありこのラウンドの責任ではない）。最初に見つかったものを使う。
      if (!index.has(key)) {
        index.set(key, finding.id);
      }
    }
  }
  return index;
}

export function classifyRawFindingsMechanically(input: {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  excludedFindingIdsFromExactDuplicateIndex?: ReadonlySet<string>;
}): MechanicalClassificationResult {
  const output = createEmptyManagerOutput();
  const residualRawFindings: RawFinding[] = [];
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const exactDuplicateIndex = buildExactDuplicateIndex(
    input.previousLedger,
    input.excludedFindingIdsFromExactDuplicateIndex === undefined
      ? new Set()
      : input.excludedFindingIdsFromExactDuplicateIndex,
  );

  const resolvedByFindingId = new Map<string, { findingId: string; rawFindingIds: string[]; evidence: string }>();
  const matchesByFindingId = new Map<string, { findingId: string; rawFindingIds: string[] }>();
  const rawsByFindingId = new Map<string, RawFinding[]>();

  const trackRaw = (findingId: string, raw: RawFinding): void => {
    const list = rawsByFindingId.get(findingId) ?? [];
    list.push(raw);
    rawsByFindingId.set(findingId, list);
  };

  for (const raw of input.rawFindings) {
    const relation = effectiveRawFindingRelation(raw);

    // ケース3: resolution_confirmation は現行どおり。
    if (relation === 'resolution_confirmation') {
      const target = raw.targetFindingId === undefined ? undefined : findingsById.get(raw.targetFindingId);
      if (target !== undefined && target.status === 'open') {
        const entry = resolvedByFindingId.get(target.id)
          ?? { findingId: target.id, rawFindingIds: [], evidence: raw.description };
        entry.rawFindingIds.push(raw.rawFindingId);
        resolvedByFindingId.set(target.id, entry);
        trackRaw(target.id, raw);
        continue;
      }
      // 対象不明・既に解消済みへの確認は判断（reopen / conflict / no-op）が絡むため LLM へ。
      residualRawFindings.push(raw);
      continue;
    }

    // ケース2: 明示参照。対象状態が relation と整合する場合だけ機械で確定する。
    if (relation === 'persists' || relation === 'reopened') {
      const target = raw.targetFindingId === undefined ? undefined : findingsById.get(raw.targetFindingId);
      if (target !== undefined) {
        if (relation === 'persists' && target.status === 'open') {
          const entry = matchesByFindingId.get(target.id) ?? { findingId: target.id, rawFindingIds: [] };
          entry.rawFindingIds.push(raw.rawFindingId);
          matchesByFindingId.set(target.id, entry);
          trackRaw(target.id, raw);
          continue;
        }
        // reopened はコード側で lifecycle 遷移まで確定させると、他の同ラウンド
        // raw との衝突（例: 同じ finding への conflict）を canonicalize が拾えなく
        // なる。reopen は manager の判断に委ねる（残余へ）。
      }
      // 対象不明・状態不整合は意味矛盾を機械で検出できないため manager 送り。
      residualRawFindings.push(raw);
      continue;
    }

    // ケース1: 完全同一の raw。'new' relation でも、既存 open finding に紐づく
    // raw のいずれかと内容が完全一致するなら同一問題として機械 same にする。
    const exactMatchFindingId = exactDuplicateIndex.get(exactDuplicateKey(raw));
    if (exactMatchFindingId !== undefined) {
      const entry = matchesByFindingId.get(exactMatchFindingId) ?? { findingId: exactMatchFindingId, rawFindingIds: [] };
      entry.rawFindingIds.push(raw.rawFindingId);
      matchesByFindingId.set(exactMatchFindingId, entry);
      trackRaw(exactMatchFindingId, raw);
      continue;
    }

    residualRawFindings.push(raw);
  }

  // 同じ指摘に「解消確認」と「再報告（一致）」が同時に来た場合は
  // レビュワー間の食い違いであり、conflict 裁定は manager の判断領域。
  // 両側の raw をすべて residual に落とし、機械分類からは取り下げる。
  for (const findingId of [...resolvedByFindingId.keys()]) {
    if (matchesByFindingId.has(findingId)) {
      resolvedByFindingId.delete(findingId);
      matchesByFindingId.delete(findingId);
      residualRawFindings.push(...(rawsByFindingId.get(findingId) ?? []));
    }
  }

  output.resolvedFindings = [...resolvedByFindingId.values()];
  output.matches = [...matchesByFindingId.values()];
  return { output, residualRawFindings };
}

function mergeByFindingId<T extends { findingId: string; rawFindingIds: string[] }>(
  base: readonly T[],
  extra: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...base, ...extra]) {
    const existing = merged.get(entry.findingId);
    if (existing === undefined) {
      merged.set(entry.findingId, { ...entry, rawFindingIds: [...entry.rawFindingIds] });
      continue;
    }
    const seen = new Set(existing.rawFindingIds);
    for (const rawFindingId of entry.rawFindingIds) {
      if (!seen.has(rawFindingId)) {
        existing.rawFindingIds.push(rawFindingId);
      }
    }
  }
  return [...merged.values()];
}

/** 機械分類の結果と LLM manager の結果を統合する。findingId 重複は rawFindingIds を合併する。 */
/**
 * 機械分類の結果と LLM 判断の組み立て結果を1つの出力へ束ねる。
 *
 * 束ねた直後に canonicalize する。resolution_confirmation は機械分類が処理して
 * resolvedFindings に入り、同じ finding への残存指摘は LLM 側の matches に入るため、
 * 「1 finding = 1 決定」を破る衝突はこの merge で初めて生まれるため、
 * 組み立て側だけを直しても本番経路は直らない。
 */
export function mergeFindingManagerOutputs(
  base: FindingManagerOutput,
  extra: FindingManagerOutput,
): FindingManagerOutput {
  return canonicalizeFindingManagerOutput({
    matches: mergeByFindingId(base.matches, extra.matches),
    newFindings: [...base.newFindings, ...extra.newFindings],
    resolvedFindings: mergeByFindingId(base.resolvedFindings, extra.resolvedFindings),
    reopenedFindings: mergeByFindingId(base.reopenedFindings, extra.reopenedFindings),
    conflicts: [...base.conflicts, ...extra.conflicts],
    resolvedConflicts: [...base.resolvedConflicts, ...extra.resolvedConflicts],
    waivedFindings: [...base.waivedFindings, ...extra.waivedFindings],
    disputeNotes: [...base.disputeNotes, ...extra.disputeNotes],
    invalidatedFindings: [...base.invalidatedFindings, ...extra.invalidatedFindings],
    duplicateFindings: [...base.duplicateFindings, ...extra.duplicateFindings],
    dismissedFindings: [...base.dismissedFindings, ...extra.dismissedFindings],
  });
}
