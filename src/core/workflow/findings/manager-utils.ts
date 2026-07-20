import { DISMISSABLE_PROVISIONAL_KINDS } from '../../models/finding-types.js';
import { validateLocationAdmission } from './admission-validation.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import type { AssembleManagerOutputResult } from './decision-assembly.js';
import type { FindingLedgerEntry, FindingManagerOutput } from './types.js';

const DISMISSABLE_KIND_SET: ReadonlySet<string> = new Set(DISMISSABLE_PROVISIONAL_KINDS);

/**
 * この open provisional が manager の dismiss 裁定対象か。
 * - kind は DISMISSABLE_PROVISIONAL_KINDS のみ（overflow / budget / interrupted /
 *   stale 系は処理失敗の証跡なので裁定で消させない）
 * - raw-meaning-ambiguous は解釈 epoch を使い切ってから — 解釈ラダーが
 *   所有権を持つ間は裁定に回さない（回すと解釈と裁定が同じ lineage を
 *   同時に扱い、解釈上限のテスト不変条件も壊れる）
 */
export function isDismissCandidate(finding: FindingLedgerEntry): boolean {
  if (finding.status !== 'open' || finding.provisional === undefined) {
    return false;
  }
  if (!DISMISSABLE_KIND_SET.has(finding.provisional.kind)) {
    return false;
  }
  if (
    finding.provisional.kind === 'raw-meaning-ambiguous'
    && finding.provisional.interpretationEpochs < MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage
  ) {
    return false;
  }
  return true;
}

/**
 * manager の dismissDecisions が選択してよい候補。値はプロンプト提示用の説明行。
 * 候補条件は isDismissCandidate が唯一の定義。
 */
export function computeDismissCandidates(
  findings: readonly FindingLedgerEntry[],
): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const finding of findings) {
    if (!isDismissCandidate(finding)) {
      continue;
    }
    candidates.set(
      finding.id,
      `[${finding.provisional!.kind}] ${finding.title} — ${finding.provisional!.reason}`,
    );
  }
  return candidates;
}

export function computeInvalidLocationCandidates(
  cwd: string,
  findings: readonly FindingLedgerEntry[],
): Map<string, string> {
  const candidates = new Map<string, string>();
  for (const finding of findings) {
    if (finding.status !== 'open' || finding.location === undefined || finding.provisional !== undefined) {
      continue;
    }
    const result = validateLocationAdmission(cwd, finding.location);
    if (!result.ok && result.outcome === 'invalid') {
      candidates.set(finding.id, result.reason);
    }
  }
  return candidates;
}

export function describeManagerRejections(assembly: AssembleManagerOutputResult): string[] {
  return [
    ...assembly.rejectedRawDecisions.map((rejection) => (
      'rawFindingId' in rejection
        ? `rawDecisions: raw finding "${rejection.rawFindingId}" (${rejection.decision}) rejected: ${rejection.reason}`
        : `rawDecisions: canonical finding "${rejection.findingId}" (${rejection.decision}) rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedDisputeDecisions.map((rejection) => (
      `disputeDecisions: finding "${rejection.findingId}" (${rejection.decision}) rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedConflictDecisions.map((rejection) => (
      `conflictDecisions: conflict "${rejection.conflictId}" (${rejection.decision}) rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedCarriedConflicts.map((rejection) => (
      `carriedConflicts: conflict "${rejection.conflictId}" (findings: ${rejection.findingIds.join(', ')}) rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedInvalidateDecisions.map((rejection) => (
      `invalidateDecisions: finding "${rejection.findingId}" rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedDuplicateDecisions.map((rejection) => (
      `duplicateDecisions: canonical "${rejection.canonicalFindingId}" (duplicates: ${rejection.duplicateFindingIds.join(', ')}) rejected: ${rejection.reason}`
    )),
    ...assembly.rejectedDismissDecisions.map((rejection) => (
      `dismissDecisions: finding "${rejection.findingId}" rejected: ${rejection.reason}`
    )),
  ];
}

export function collectLandedRawIds(output: FindingManagerOutput): Set<string> {
  return new Set([
    ...output.matches.flatMap((match) => match.rawFindingIds),
    ...output.newFindings.flatMap((finding) => finding.rawFindingIds),
    ...output.resolvedFindings.flatMap((resolved) => resolved.rawFindingIds),
    ...output.reopenedFindings.flatMap((reopened) => reopened.rawFindingIds),
    ...output.conflicts.flatMap((conflict) => conflict.rawFindingIds),
  ]);
}
