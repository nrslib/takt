import type { FindingLedger, FindingManagerOutput, RawFinding } from './types.js';
import {
  compareRawAdjudicationCandidates,
  type RawAdjudicationCandidate,
} from './raw-adjudication-priority.js';
import { isReplayOriginPromotionSource } from './provisional-promotion-eligibility.js';
import type { VerifiedReplayOriginAuthority } from './provisional-recovery-origin.js';

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
      ? {
          ...match,
          rawFindingIds: [
            ...new Set([...match.rawFindingIds, ...rawFindingIds]),
          ],
        }
      : match
  ));
}

function addPromotionAuthorities(
  current: ReadonlyMap<string, readonly VerifiedReplayOriginAuthority[]>,
  findingId: string,
  authorities: readonly VerifiedReplayOriginAuthority[],
): Map<string, readonly VerifiedReplayOriginAuthority[]> {
  return new Map([
    ...current,
    [
      findingId,
      [
        ...(current.get(findingId) ?? []),
        ...authorities,
      ],
    ],
  ]);
}

export function applyReplayOriginSettlement(input: {
  output: FindingManagerOutput;
  origins: ReadonlyMap<string, VerifiedReplayOriginAuthority>;
  freshLedger: FindingLedger;
  cleanRawIds: ReadonlySet<string>;
  wireById: ReadonlyMap<string, RawFinding>;
}): {
  output: FindingManagerOutput;
  promotedFindingIds: Set<string>;
  promotionAuthoritiesByFindingId: ReadonlyMap<
    string,
    readonly VerifiedReplayOriginAuthority[]
  >;
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
  const eligibleOrigins = new Map([...input.origins].filter(
    ([rawFindingId, authority]) => (
      eligibleProcessesById.has(
        authority.recoveryOrigin.provisionalFindingId,
      )
      && authority.replayRawFindingId === rawFindingId
      && input.cleanRawIds.has(rawFindingId)
      && input.wireById.has(rawFindingId)
    ),
  ));
  const promotionEligibleOrigins = new Map([...eligibleOrigins].filter(
    ([rawFindingId, authority]) => {
      const provisional = eligibleProcessesById.get(
        authority.recoveryOrigin.provisionalFindingId,
      );
      const wire = input.wireById.get(rawFindingId);
      return provisional !== undefined
        && wire !== undefined
        && isReplayOriginPromotionSource({
          ledger: input.freshLedger,
          provisional,
          wire,
          authority,
        });
    },
  ));

  let matches = input.output.matches.map((match) => ({
    ...match,
    rawFindingIds: [...match.rawFindingIds],
  }));
  let promotedFindingIds = new Set<string>();
  let promotionAuthoritiesByFindingId = new Map<
    string,
    readonly VerifiedReplayOriginAuthority[]
  >();
  let resolvedByMapping = new Map<string, string>();
  let settledReplayRawIds = new Set<string>();
  const newFindings = input.output.newFindings.flatMap((group) => {
    const replayOrigins = group.rawFindingIds.flatMap((rawFindingId) => {
      const origin = promotionEligibleOrigins.get(rawFindingId);
      return origin === undefined ? [] : [[rawFindingId, origin] as const];
    });
    if (replayOrigins.length === 0) {
      return [group];
    }
    const canonicalProcess = replayOrigins
      .map(([, authority]) => eligibleProcessesById.get(
        authority.recoveryOrigin.provisionalFindingId,
      )!)
      .sort(compareRawAdjudicationCandidates)[0]!;
    const promotedRawFindingIds = replayOrigins.map(
      ([rawFindingId]) => rawFindingId,
    );
    matches = mergeMatch(matches, canonicalProcess.id, promotedRawFindingIds);
    const retainedRawFindingIds = group.rawFindingIds.filter(
      (rawFindingId) => !promotionEligibleOrigins.has(rawFindingId),
    );
    return retainedRawFindingIds.length === 0
      ? []
      : [{ ...group, rawFindingIds: retainedRawFindingIds }];
  });

  for (const match of matches) {
    for (const rawFindingId of match.rawFindingIds) {
      const authority = eligibleOrigins.get(rawFindingId);
      if (authority === undefined) {
        continue;
      }
      const originFindingId = authority.recoveryOrigin.provisionalFindingId;
      settledReplayRawIds = new Set([...settledReplayRawIds, rawFindingId]);
      if (
        match.findingId === originFindingId
        && promotionEligibleOrigins.has(rawFindingId)
      ) {
        promotedFindingIds = new Set([
          ...promotedFindingIds,
          originFindingId,
        ]);
        promotionAuthoritiesByFindingId = addPromotionAuthorities(
          promotionAuthoritiesByFindingId,
          originFindingId,
          [authority],
        );
      } else if (match.findingId !== originFindingId) {
        resolvedByMapping = new Map([
          ...resolvedByMapping,
          [originFindingId, match.findingId],
        ]);
      }
    }
  }

  for (
    const landing of [
      ...input.output.reopenedFindings,
      ...input.output.resolvedFindings,
    ]
  ) {
    for (const rawFindingId of landing.rawFindingIds) {
      const authority = eligibleOrigins.get(rawFindingId);
      if (authority === undefined) {
        continue;
      }
      settledReplayRawIds = new Set([...settledReplayRawIds, rawFindingId]);
      resolvedByMapping = new Map([
        ...resolvedByMapping,
        [authority.recoveryOrigin.provisionalFindingId, landing.findingId],
      ]);
    }
  }

  const conflicts = input.output.conflicts.map((conflict) => {
    const replayOrigins = conflict.rawFindingIds.flatMap((rawFindingId) => {
      const authority = promotionEligibleOrigins.get(rawFindingId);
      return authority === undefined
        ? []
        : [[rawFindingId, authority] as const];
    });
    if (replayOrigins.length === 0) {
      return conflict;
    }
    const authoritiesByOriginFindingId = new Map<
      string,
      VerifiedReplayOriginAuthority[]
    >();
    for (const [, authority] of replayOrigins) {
      const originFindingId = authority.recoveryOrigin.provisionalFindingId;
      authoritiesByOriginFindingId.set(
        originFindingId,
        [
          ...(authoritiesByOriginFindingId.get(originFindingId) ?? []),
          authority,
        ],
      );
    }
    promotedFindingIds = new Set([
      ...promotedFindingIds,
      ...authoritiesByOriginFindingId.keys(),
    ]);
    for (const [originFindingId, authorities] of authoritiesByOriginFindingId) {
      promotionAuthoritiesByFindingId = addPromotionAuthorities(
        promotionAuthoritiesByFindingId,
        originFindingId,
        authorities,
      );
    }
    settledReplayRawIds = new Set([
      ...settledReplayRawIds,
      ...replayOrigins.map(([rawFindingId]) => rawFindingId),
    ]);
    return {
      ...conflict,
      findingIds: [
        ...new Set([
          ...conflict.findingIds,
          ...authoritiesByOriginFindingId.keys(),
        ]),
      ],
    };
  });

  return {
    output: { ...input.output, matches, newFindings, conflicts },
    promotedFindingIds,
    promotionAuthoritiesByFindingId,
    resolvedByMapping,
    settledReplayRawIds,
  };
}
