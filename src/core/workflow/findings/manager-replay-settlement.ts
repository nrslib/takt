import type { FindingLedger, FindingManagerOutput, RawFinding } from './types.js';
import {
  compareRawAdjudicationCandidates,
  type RawAdjudicationCandidate,
} from './raw-adjudication-priority.js';
import { isProvisionalPromotionSource } from './provisional-promotion-eligibility.js';

export interface ProvisionalReplayOrigin {
  provisionalFindingId: string;
  expectedProvisionalRevision: number;
  expectedTargetIdentityHash: string | null;
}

function mergeMatch(
  matches: FindingManagerOutput['matches'],
  findingId: string,
  rawFindingIds: readonly string[],
): FindingManagerOutput['matches'] {
  const existing = matches.find((match) => match.findingId === findingId);
  if (existing === undefined) {
    return [...matches, {
      findingId,
      rawFindingIds: [...rawFindingIds],
      evidence: 'Engine replay confirmed the provisional observation',
    }];
  }
  return matches.map((match) => (
    match.findingId === findingId
      ? { ...match, rawFindingIds: [...new Set([...match.rawFindingIds, ...rawFindingIds])] }
      : match
  ));
}

export function applyReplayOriginSettlement(input: {
  output: FindingManagerOutput;
  origins: ReadonlyMap<string, ProvisionalReplayOrigin>;
  freshLedger: FindingLedger;
  cleanRawIds: ReadonlySet<string>;
  wireById: ReadonlyMap<string, RawFinding>;
}): {
  output: FindingManagerOutput;
  promotedFindingIds: Set<string>;
  resolvedByMapping: Map<string, string>;
  settledReplayRawIds: Set<string>;
} {
  const eligibleProcessesById = new Map(
    input.freshLedger.findings
      .filter((finding): finding is RawAdjudicationCandidate => (
        finding.status === 'open' && finding.provisional !== undefined
      ))
      .map((finding) => [finding.id, finding]),
  );
  const eligibleOrigins = new Map([...input.origins].filter(([rawFindingId, origin]) => {
    const process = eligibleProcessesById.get(origin.provisionalFindingId);
    const wire = input.wireById.get(rawFindingId);
    return process !== undefined
      && process.revision === origin.expectedProvisionalRevision
      && process.targetIdentityHash === origin.expectedTargetIdentityHash
      && input.cleanRawIds.has(rawFindingId)
      && wire !== undefined
      && isProvisionalPromotionSource({
        ledger: input.freshLedger,
        provisional: process,
        wire,
      });
  }));
  let matches = input.output.matches.map((match) => ({ ...match, rawFindingIds: [...match.rawFindingIds] }));
  let promotedFindingIds = new Set<string>();
  let resolvedByMapping = new Map<string, string>();
  let settledReplayRawIds = new Set<string>();
  const newFindings = input.output.newFindings.flatMap((group) => {
    const replayOrigins = group.rawFindingIds.flatMap((rawFindingId) => {
      const origin = eligibleOrigins.get(rawFindingId);
      return origin === undefined ? [] : [[rawFindingId, origin] as const];
    });
    if (replayOrigins.length === 0) {
      return [group];
    }
    const processIds = new Set(replayOrigins.map(([, origin]) => origin.provisionalFindingId));
    const canonicalProcess = [...processIds]
      .map((processId) => eligibleProcessesById.get(processId)!)
      .sort(compareRawAdjudicationCandidates)[0]!;
    matches = mergeMatch(
      matches,
      canonicalProcess.id,
      replayOrigins.map(([rawFindingId]) => rawFindingId),
    );
    const promotedRawFindingIds = new Set(
      replayOrigins.map(([rawFindingId]) => rawFindingId),
    );
    const retainedRawFindingIds = group.rawFindingIds.filter(
      (rawFindingId) => !promotedRawFindingIds.has(rawFindingId),
    );
    return retainedRawFindingIds.length === 0
      ? []
      : [{ ...group, rawFindingIds: retainedRawFindingIds }];
  });
  for (const match of matches) {
    for (const rawFindingId of match.rawFindingIds) {
      const origin = eligibleOrigins.get(rawFindingId);
      if (origin === undefined) {
        continue;
      }
      settledReplayRawIds = new Set([...settledReplayRawIds, rawFindingId]);
      if (match.findingId === origin.provisionalFindingId) {
        promotedFindingIds = new Set([...promotedFindingIds, origin.provisionalFindingId]);
      } else {
        resolvedByMapping = new Map([
          ...resolvedByMapping,
          [origin.provisionalFindingId, match.findingId],
        ]);
      }
    }
  }
  for (const landing of [...input.output.reopenedFindings, ...input.output.resolvedFindings]) {
    for (const rawFindingId of landing.rawFindingIds) {
      const origin = eligibleOrigins.get(rawFindingId);
      if (origin === undefined) {
        continue;
      }
      settledReplayRawIds = new Set([...settledReplayRawIds, rawFindingId]);
      resolvedByMapping = new Map([
        ...resolvedByMapping,
        [origin.provisionalFindingId, landing.findingId],
      ]);
    }
  }
  const conflicts = input.output.conflicts.map((conflict) => {
    const replayOrigins = conflict.rawFindingIds.flatMap((rawFindingId) => {
      const origin = eligibleOrigins.get(rawFindingId);
      return origin === undefined ? [] : [[rawFindingId, origin] as const];
    });
    if (replayOrigins.length === 0) {
      return conflict;
    }
    const processIds = replayOrigins.map(([, origin]) => origin.provisionalFindingId);
    promotedFindingIds = new Set([...promotedFindingIds, ...processIds]);
    settledReplayRawIds = new Set([
      ...settledReplayRawIds,
      ...replayOrigins.map(([rawFindingId]) => rawFindingId),
    ]);
    return { ...conflict, findingIds: [...new Set([...conflict.findingIds, ...processIds])] };
  });
  return {
    output: { ...input.output, matches, newFindings, conflicts },
    promotedFindingIds,
    resolvedByMapping,
    settledReplayRawIds,
  };
}
