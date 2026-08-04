import type { FindingLedger, FindingManagerOutput } from './types.js';
import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { formatConflictId } from '../../models/finding-conflict-identity.js';
import {
  createEngineDerivedWaiverConflict,
  createEngineDerivedWaiverDisputeNote,
  isEngineDerivedWaiverConflict,
  isEngineDerivedWaiverDisputeNote,
  plainFindingManagerConflict,
} from './waiver-conflict.js';

export interface RejectedDuplicateNormalization {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  reason: string;
}

export function collectActiveConflictFindingIds(ledger: FindingLedger): Set<string> {
  return new Set(
    ledger.conflicts
      .filter((conflict) => conflict.status === 'active')
      .flatMap((conflict) => conflict.findingIds),
  );
}

/**
 * conflict（この出力の conflicts / 台帳の active conflict）が canonical または
 * duplicate に触れる duplicateDecision を項目単位で不採用にする。conflict の
 * identity は裁定（adjudication）経路の管轄であり、統合で集約を変えない。
 */
export function rejectConflictTouchedDuplicates(input: {
  output: FindingManagerOutput;
  activeConflictFindingIds: ReadonlySet<string>;
}): { output: FindingManagerOutput; rejectedDuplicateDecisions: RejectedDuplicateNormalization[] } {
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
  if (rejectedDuplicateDecisions.length === 0) {
    return { output, rejectedDuplicateDecisions: [] };
  }
  return {
    output: { ...output, duplicateFindings: acceptedDuplicates },
    rejectedDuplicateDecisions,
  };
}

/**
 * superseded になる finding への match を canonical へ付け替える。統合とは
 * 「同じ問題の観測を1つの finding へ束ねる」ことなので、duplicate への再観測は
 * canonical の観測そのもの。
 *
 * 適用は保存直前の1回だけ（normalizeMergedManagerPlan）。組み立て段階で
 * 付け替えると、後着の conflict（ladder / fresh ledger）で統合が不採用に
 * なったとき付け替え済み match を戻せない。決定段階の最終検証はこの関数で
 * 作った検証ビューに対して行い、保存される計画は未転写のまま保つ。
 * 純関数かつ冪等: 付け替え後の出力に superseded を指す match は存在しない。
 */
export function transferSupersededMatches(output: FindingManagerOutput): FindingManagerOutput {
  const canonicalBySuperseded = new Map(output.duplicateFindings.flatMap((duplicate) => (
    duplicate.duplicateFindingIds.map((findingId) => [findingId, duplicate.canonicalFindingId] as const)
  )));
  if (canonicalBySuperseded.size === 0 || output.matches.every((match) => !canonicalBySuperseded.has(match.findingId))) {
    return output;
  }
  const transferred: FindingManagerOutput['matches'] = [];
  const indexByFindingId = new Map<string, number>();
  for (const match of output.matches) {
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
  return { ...output, matches: transferred };
}

/**
 * waive と同ラウンド証拠の衝突を、保存直前に必ず次のどちらか一方へ揃える。
 *
 * - raw-backed conflict が残る: その conflict を正本とし、engine-derived marker は外す
 * - raw-backed conflict が消えたが同じ finding の current match が残る:
 *   rawless engine-derived conflict を復元する
 *
 * marker は LLM/schema の語彙ではなく engine 内部の由来情報である。raw ID を追加した
 * object spread で暗黙継承せず、raw-backed 側は必ず plain object を明示生成する。
 */
export function normalizeEngineDerivedWaiverConflicts(
  output: FindingManagerOutput,
): FindingManagerOutput {
  const waiverFindingIds = new Set([
    ...output.disputeNotes.flatMap((note) => (
      isEngineDerivedWaiverDisputeNote(note) ? [note.findingId] : []
    )),
    ...output.conflicts.flatMap((conflict) => (
      isEngineDerivedWaiverConflict(conflict) ? conflict.findingIds : []
    )),
  ]);
  if (waiverFindingIds.size === 0) {
    return output;
  }

  let changed = false;
  let conflicts = output.conflicts.map((conflict) => {
    if (!isEngineDerivedWaiverConflict(conflict) || conflict.rawFindingIds.length === 0) {
      return conflict;
    }
    changed = true;
    return plainFindingManagerConflict(conflict);
  });

  for (const findingId of waiverFindingIds) {
    const hasRawBackedConflict = conflicts.some((conflict) => (
      conflict.rawFindingIds.length > 0 && conflict.findingIds.includes(findingId)
    ));
    if (hasRawBackedConflict) {
      const retained = conflicts.filter((conflict) => !(
        isEngineDerivedWaiverConflict(conflict)
        && conflict.findingIds.includes(findingId)
      ));
      if (retained.length !== conflicts.length) {
        changed = true;
        conflicts = retained;
      }
      continue;
    }

    const hasCurrentMatch = output.matches.some((match) => (
      match.findingId === findingId && match.rawFindingIds.length > 0
    ));
    if (!hasCurrentMatch) {
      continue;
    }

    const replaceIndex = conflicts.findIndex((conflict) => (
      conflict.findingIds.length === 1
      && conflict.findingIds[0] === findingId
      && conflict.rawFindingIds.length === 0
    ));
    const retained = conflicts.filter((conflict) => !(
      conflict.findingIds.length === 1
      && conflict.findingIds[0] === findingId
      && conflict.rawFindingIds.length === 0
    ));
    const insertionIndex = replaceIndex === -1 ? retained.length : replaceIndex;
    retained.splice(insertionIndex, 0, createEngineDerivedWaiverConflict(findingId));
    conflicts = retained;
    changed = true;
  }

  return changed ? { ...output, conflicts } : output;
}

/**
 * ladder マージ後・reconciler 直前の最終正規化。mergeOutputs が後着させるのは
 * matches / newFindings / conflicts だけなので、閉じる決定（resolved / invalidated /
 * dismissed / waived）と duplicate に対する「後着証拠との衝突」をここで一括して
 * 既存の優先規則（証拠 > 裁定、conflict 管轄 > 統合）で解消する:
 *
 * 1. resolved × match/conflict は canonicalize と同じ規則で conflict へ畳む
 * 2. 同一 finding 集合の conflict を統合し、部分重複する後着 conflict は不採用
 * 3. reopened × match は match を reopened の観測へ畳む（matches|reopenedFindings は排他）
 * 4. invalidate は後着 match/conflict が触れたら項目単位で不採用。
 *    manager dismissal はすべて不採用とし、verified terminal adjudication に限定する
 * 5. waive は後着証拠が触れたら disputeNote へ降格（finding は open のまま）
 * 6. conflict が触れる duplicate を不採用にし、残る統合の match を canonical へ転写
 */
export function normalizeMergedManagerPlan(input: {
  output: FindingManagerOutput;
  activeConflictFindingIds: ReadonlySet<string>;
}): {
  output: FindingManagerOutput;
  rejections: string[];
} {
  const rejections = input.output.dismissedFindings.map((dismissed) => (
    `dismissDecisions: finding "${dismissed.findingId}" rejected at save time: manager dismissal requires verified terminal adjudication`
  ));
  let output = canonicalizeFindingManagerOutput({
    ...input.output,
    dismissedFindings: [],
  });
  output = mergeOverlappingConflicts(output, rejections);

  const evidenceFindingIds = new Set([
    ...output.matches.map((match) => match.findingId),
    ...output.conflicts.flatMap((conflict) => conflict.findingIds),
  ]);
  output = foldMatchesIntoReopened(output);
  output = dropLateEvidenceClosures(output, evidenceFindingIds, rejections);
  output = normalizeEngineDerivedWaiverConflicts(output);

  const duplicateResult = rejectConflictTouchedDuplicates({
    output,
    activeConflictFindingIds: input.activeConflictFindingIds,
  });
  rejections.push(...duplicateResult.rejectedDuplicateDecisions.map((rejection) => (
    `duplicateDecisions: canonical "${rejection.canonicalFindingId}" (duplicates: ${rejection.duplicateFindingIds.join(', ')}) rejected at save time: ${rejection.reason}`
  )));

  return {
    output: transferSupersededMatches(duplicateResult.output),
    rejections,
  };
}

/** 同一 finding 集合の conflict を統合（rawFindingIds を合併）し、部分重複する後着 conflict は不採用にする。 */
function mergeOverlappingConflicts(output: FindingManagerOutput, rejections: string[]): FindingManagerOutput {
  const rawBackedConflicts = output.conflicts.filter(
    (conflict) => conflict.rawFindingIds.length > 0,
  );
  let changed = false;
  const candidates = output.conflicts.flatMap((conflict) => {
    if (
      isEngineDerivedWaiverConflict(conflict)
      && conflict.rawFindingIds.length === 0
      && rawBackedConflicts.some((rawBacked) => rawBacked.findingIds.some(
        (findingId) => conflict.findingIds.includes(findingId),
      ))
    ) {
      changed = true;
      return [];
    }
    if (isEngineDerivedWaiverConflict(conflict) && conflict.rawFindingIds.length > 0) {
      changed = true;
      return [plainFindingManagerConflict(conflict)];
    }
    return [conflict];
  });
  if (candidates.length < 2) {
    return changed ? { ...output, conflicts: candidates } : output;
  }
  const merged: FindingManagerOutput['conflicts'] = [];
  const indexByConflictId = new Map<string, number>();
  const claimedFindingIds = new Set<string>();
  for (const conflict of candidates) {
    const conflictId = formatConflictId(conflict);
    const existingIndex = indexByConflictId.get(conflictId);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]!;
      const rawFindingIds = [...new Set([
        ...existing.rawFindingIds,
        ...conflict.rawFindingIds,
      ])];
      const rawBacked = existing.rawFindingIds.length > 0
        ? existing
        : conflict.rawFindingIds.length > 0
          ? conflict
          : undefined;
      if (rawBacked !== undefined) {
        merged[existingIndex] = {
          ...plainFindingManagerConflict(rawBacked),
          rawFindingIds,
        };
      } else if (
        existing.findingIds.length === 1
        && (isEngineDerivedWaiverConflict(existing) || isEngineDerivedWaiverConflict(conflict))
      ) {
        merged[existingIndex] = createEngineDerivedWaiverConflict(existing.findingIds[0]!);
      } else {
        merged[existingIndex] = {
          ...plainFindingManagerConflict(existing),
          rawFindingIds,
        };
      }
      changed = true;
      continue;
    }
    const overlapping = conflict.findingIds.filter((findingId) => claimedFindingIds.has(findingId));
    if (overlapping.length > 0) {
      rejections.push(
        `conflicts: conflict "${conflictId}" rejected at save time: finding(s) ${overlapping.map((findingId) => `"${findingId}"`).join(', ')} already referenced by another conflict in this output`,
      );
      changed = true;
      continue;
    }
    indexByConflictId.set(conflictId, merged.length);
    merged.push(conflict);
    for (const findingId of conflict.findingIds) {
      claimedFindingIds.add(findingId);
    }
  }
  return changed ? { ...output, conflicts: merged } : output;
}

/** reopened と同じ finding への後着 match を reopened の観測へ畳む（reopen 自体が今ラウンドの観測）。 */
function foldMatchesIntoReopened(output: FindingManagerOutput): FindingManagerOutput {
  const reopenedIndexByFindingId = new Map(
    output.reopenedFindings.map((reopened, index) => [reopened.findingId, index]),
  );
  if (output.matches.every((match) => !reopenedIndexByFindingId.has(match.findingId))) {
    return output;
  }
  const reopenedFindings = [...output.reopenedFindings];
  const matches = output.matches.filter((match) => {
    const index = reopenedIndexByFindingId.get(match.findingId);
    if (index === undefined) {
      return true;
    }
    const reopened = reopenedFindings[index]!;
    reopenedFindings[index] = {
      ...reopened,
      rawFindingIds: [...new Set([...reopened.rawFindingIds, ...match.rawFindingIds])],
    };
    return false;
  });
  return { ...output, matches, reopenedFindings };
}

/** 後着の match/conflict が触れた invalidate を不採用にし、waive を disputeNote へ降格する。 */
function dropLateEvidenceClosures(
  output: FindingManagerOutput,
  evidenceFindingIds: ReadonlySet<string>,
  rejections: string[],
): FindingManagerOutput {
  const invalidatedFindings = output.invalidatedFindings.filter((invalidated) => {
    if (!evidenceFindingIds.has(invalidated.findingId)) {
      return true;
    }
    rejections.push(
      `invalidateDecisions: finding "${invalidated.findingId}" rejected at save time: re-observed (match/conflict) after merge; evidence takes precedence over location invalidation`,
    );
    return false;
  });
  const demotedWaives = output.waivedFindings.filter((waived) => evidenceFindingIds.has(waived.findingId));
  if (invalidatedFindings.length === output.invalidatedFindings.length
    && demotedWaives.length === 0) {
    return output;
  }
  rejections.push(...demotedWaives.map((waived) => (
    `disputeDecisions: finding "${waived.findingId}" (waive) demoted to note at save time: re-observed (match/conflict) after merge; the finding stays open`
  )));
  return {
    ...output,
    invalidatedFindings,
    waivedFindings: output.waivedFindings.filter((waived) => !evidenceFindingIds.has(waived.findingId)),
    disputeNotes: [
      ...output.disputeNotes,
      ...demotedWaives.map((waived) => createEngineDerivedWaiverDisputeNote({
        findingId: waived.findingId,
        reason: waived.reason,
        evidence: waived.evidence,
      })),
    ],
  };
}
