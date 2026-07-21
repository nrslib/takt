import { validateLocationAdmission } from './admission-validation.js';
import { classifyProvisionalRecovery, isOpenProvisional } from './provisional-recovery.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';
import type { AssembleManagerOutputResult } from './decision-assembly.js';
import {
  DISMISSABLE_PROVISIONAL_KINDS,
  type FindingLedger,
  type FindingLedgerEntry,
  type FindingManagerOutput,
} from './types.js';

/**
 * この open provisional が manager の dismiss 裁定対象か。
 * engine 主導の recovery（解釈の前進 / source raw の再裁定 / 機械 resolve）が
 * 残っている間は候補にしない — recovery を使い切った、または最初から機械処理の
 * 余地が無い locationless provisional だけが内容の管轄裁定へ回る。
 * 分類は provisional-recovery.ts が正本。
 */
export function isDismissCandidate(finding: FindingLedgerEntry, roundsCompleted: number): boolean {
  if (!isOpenProvisional(finding)) {
    return false;
  }
  if (!(DISMISSABLE_PROVISIONAL_KINDS as readonly string[]).includes(finding.provisional.kind)) {
    return false;
  }
  return classifyProvisionalRecovery(finding.provisional, roundsCompleted) === 'terminal-adjudication';
}

/**
 * manager の dismissDecisions が選択してよい候補。値はプロンプト提示用の説明行。
 * 候補条件は isDismissCandidate が唯一の定義。
 */
export function computeDismissCandidates(
  ledger: FindingLedger,
): Map<string, string> {
  const candidates = new Map<string, string>();
  const roundsCompleted = stopBudgetRoundsCompleted(ledger);
  for (const finding of ledger.findings) {
    if (!isDismissCandidate(finding, roundsCompleted)) {
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
