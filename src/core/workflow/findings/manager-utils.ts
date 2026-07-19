import { validateLocationAdmission } from './admission-validation.js';
import type { AssembleManagerOutputResult } from './decision-assembly.js';
import type { FindingLedgerEntry, FindingManagerOutput } from './types.js';

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
