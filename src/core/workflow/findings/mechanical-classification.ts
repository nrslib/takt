import type { FindingLedger, FindingLedgerEntry, FindingManagerOutput, RawFinding } from './types.js';

/**
 * raw findings のうち、構造化フィールドの等価比較だけで分類が確定するものを
 * コードで処理し、判断が必要な残り（residual）だけを LLM manager に回すための
 * 機械分類。
 *
 * 保守的な原則: フィールド等価で一意に決まらないものは全て residual に落とす。
 * - resolution_confirmation は targetFindingId が open の指摘を指す場合のみ解消。
 * - issue は「open の指摘と location + familyTag が完全一致し、候補が一意」の
 *   場合のみ既存一致。解消済み指摘への一致（reopen 判断）や候補複数は residual。
 * - 新規判定（どの既存指摘とも無関係）は重複グルーピングの判断を伴うため
 *   機械では確定させず residual に落とす。
 */
export interface MechanicalClassificationResult {
  output: FindingManagerOutput;
  residualRawFindings: RawFinding[];
}

function emptyManagerOutput(): FindingManagerOutput {
  return {
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
  };
}

function buildFindingFamilyTags(ledger: FindingLedger): Map<string, Set<string>> {
  const rawById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const tags = new Map<string, Set<string>>();
  for (const finding of ledger.findings) {
    const set = new Set<string>();
    for (const rawFindingId of finding.rawFindingIds) {
      const raw = rawById.get(rawFindingId);
      if (raw) {
        set.add(raw.familyTag);
      }
    }
    tags.set(finding.id, set);
  }
  return tags;
}

export function classifyRawFindingsMechanically(input: {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
}): MechanicalClassificationResult {
  const output = emptyManagerOutput();
  const residualRawFindings: RawFinding[] = [];
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const familyTags = buildFindingFamilyTags(input.previousLedger);
  const openFindings = input.previousLedger.findings.filter((finding) => finding.status === 'open');

  const resolvedByFindingId = new Map<string, { findingId: string; rawFindingIds: string[]; evidence: string }>();
  const matchesByFindingId = new Map<string, { findingId: string; rawFindingIds: string[] }>();
  const rawsByFindingId = new Map<string, RawFinding[]>();

  const trackRaw = (findingId: string, raw: RawFinding): void => {
    const list = rawsByFindingId.get(findingId) ?? [];
    list.push(raw);
    rawsByFindingId.set(findingId, list);
  };

  for (const raw of input.rawFindings) {
    if (raw.kind === 'resolution_confirmation') {
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

    // kind 未指定は issue として扱う（schema 上のデフォルト運用）。
    const candidates = raw.location === undefined
      ? []
      : openFindings.filter((finding) =>
        finding.location === raw.location && (familyTags.get(finding.id)?.has(raw.familyTag) ?? false));
    if (candidates.length === 1) {
      const target = candidates[0] as FindingLedgerEntry;
      const entry = matchesByFindingId.get(target.id) ?? { findingId: target.id, rawFindingIds: [] };
      entry.rawFindingIds.push(raw.rawFindingId);
      matchesByFindingId.set(target.id, entry);
      trackRaw(target.id, raw);
      continue;
    }
    residualRawFindings.push(raw);
  }

  // 同じ指摘に「解消確認」と「再報告（issue 一致）」が同時に来た場合は
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
export function mergeFindingManagerOutputs(
  base: FindingManagerOutput,
  extra: FindingManagerOutput,
): FindingManagerOutput {
  return {
    matches: mergeByFindingId(base.matches, extra.matches),
    newFindings: [...base.newFindings, ...extra.newFindings],
    resolvedFindings: mergeByFindingId(base.resolvedFindings, extra.resolvedFindings),
    reopenedFindings: mergeByFindingId(base.reopenedFindings, extra.reopenedFindings),
    conflicts: [...base.conflicts, ...extra.conflicts],
    resolvedConflicts: [...base.resolvedConflicts, ...extra.resolvedConflicts],
    waivedFindings: [...base.waivedFindings, ...extra.waivedFindings],
    disputeNotes: [...base.disputeNotes, ...extra.disputeNotes],
  };
}
