import type {
  FindingManagerRawDecision,
  RawDecisionKind,
  RawFinding,
} from './types.js';
import type {
  FindingAnchorRelevanceDecision,
} from '../../models/finding-types.js';

export const PROVIDER_ANCHOR_RELEVANCE_INSTRUCTION =
  'For target.kind="absence", include anchorRelevance with "relevant" or "not_relevant". For every other target kind, omit anchorRelevance entirely; the engine derives its internal "not_applicable" value.';

export interface ProviderRawDecision {
  rawFindingId: string;
  decision: RawDecisionKind;
  anchorRelevance?: FindingAnchorRelevanceDecision;
  findingId?: string;
  evidence: string;
}

function anchorRelevanceFor(
  decision: ProviderRawDecision,
  rawFinding: RawFinding,
): FindingAnchorRelevanceDecision {
  if (rawFinding.target.kind !== 'absence') {
    if (decision.anchorRelevance !== undefined) {
      throw new Error(
        `Raw finding "${decision.rawFindingId}" has target kind "${rawFinding.target.kind}" and must omit anchorRelevance`,
      );
    }
    return 'not_applicable';
  }
  if (
    decision.anchorRelevance === undefined
    || decision.anchorRelevance === 'not_applicable'
  ) {
    throw new Error(
      `Absence raw finding "${decision.rawFindingId}" requires anchorRelevance "relevant" or "not_relevant"`,
    );
  }
  return decision.anchorRelevance;
}

export function adaptProviderRawDecision<T extends ProviderRawDecision>(
  decision: T,
  rawFinding: RawFinding,
): T & FindingManagerRawDecision {
  if (decision.rawFindingId !== rawFinding.rawFindingId) {
    throw new Error(
      `Provider raw decision "${decision.rawFindingId}" does not match raw finding "${rawFinding.rawFindingId}"`,
    );
  }
  return {
    ...decision,
    anchorRelevance: anchorRelevanceFor(decision, rawFinding),
  };
}

export function adaptProviderRawDecisions<T extends ProviderRawDecision>(
  decisions: readonly T[],
  rawFindings: readonly RawFinding[],
): Array<T & FindingManagerRawDecision> {
  const rawFindingsById = new Map(
    rawFindings.map((rawFinding) => [rawFinding.rawFindingId, rawFinding]),
  );
  return decisions.map((decision) => {
    const rawFinding = rawFindingsById.get(decision.rawFindingId);
    if (rawFinding === undefined) {
      throw new Error(
        `Provider raw decision references unknown raw finding "${decision.rawFindingId}"`,
      );
    }
    return adaptProviderRawDecision(decision, rawFinding);
  });
}
