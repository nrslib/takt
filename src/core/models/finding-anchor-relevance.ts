import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../shared/utils/binary-string-comparator.js';
import { computeRawFindingIntegrityDigest } from './finding-raw-integrity.js';
import type {
  FindingAnchorAdjudication,
  FindingAnchorAuthorityAdjudication,
  FindingLifecycleOperation,
  FindingManagerRawDecision,
  RawFinding,
} from './finding-types.js';

export function absenceRawFindings(
  rawFindings: readonly RawFinding[],
): RawFinding[] {
  return rawFindings
    .filter((rawFinding) => rawFinding.target.kind === 'absence')
    .sort((left, right) => compareBinaryStrings(left.rawFindingId, right.rawFindingId));
}

export function computeManagerOutputBinding(
  decision: Pick<
    FindingManagerRawDecision,
    'rawFindingId' | 'decision' | 'findingId' | 'anchorRelevance'
  >,
): string {
  return createHash('sha256').update(canonicalJson({
    domain: 'finding-manager-output-binding',
    rawFindingId: decision.rawFindingId,
    rawDecision: decision.decision,
    findingId: decision.findingId ?? null,
    anchorDecision: decision.anchorRelevance,
  })).digest('hex');
}

export function createAnchorAdjudication(
  decision: FindingManagerRawDecision,
): FindingAnchorAdjudication {
  return {
    rawFindingId: decision.rawFindingId,
    rawDecision: decision.decision,
    findingId: decision.findingId ?? null,
    decision: decision.anchorRelevance,
    rationale: decision.evidence,
    managerOutputBinding: computeManagerOutputBinding(decision),
  };
}

export function authorityAnchorAdjudications(
  input: {
    rawFindingIds: readonly string[];
    adjudications: readonly FindingAnchorAdjudication[];
  },
): FindingAnchorAuthorityAdjudication[] {
  const adjudicationsByRawFindingId = new Map(
    input.adjudications.map((adjudication) => [
      adjudication.rawFindingId,
      adjudication,
    ]),
  );
  return [...new Set(input.rawFindingIds)]
    .sort(compareBinaryStrings)
    .map((rawFindingId) => {
      const adjudication = adjudicationsByRawFindingId.get(rawFindingId);
      if (adjudication === undefined) {
        throw new Error(`Missing anchor adjudication for raw finding "${rawFindingId}"`);
      }
      if (adjudication.decision !== 'relevant') {
        throw new Error(
          `Raw finding "${rawFindingId}" cannot authorize a lifecycle mutation with anchor decision "${adjudication.decision}"`,
        );
      }
      return {
        rawFindingId,
        decision: adjudication.decision,
        managerOutputBinding: adjudication.managerOutputBinding,
      };
    });
}

export function computeAnchorRelevanceDecisionDigest(input: {
  operation: FindingLifecycleOperation;
  rawFindings: readonly RawFinding[];
  adjudications: readonly FindingAnchorAuthorityAdjudication[];
}): string {
  const absenceRaws = absenceRawFindings(input.rawFindings);
  if (absenceRaws.length === 0) {
    throw new Error('Anchor relevance authority requires at least one absence raw finding');
  }
  const adjudicationsByRawFindingId = new Map(
    input.adjudications.map((adjudication) => [
      adjudication.rawFindingId,
      adjudication,
    ]),
  );
  const decisions = absenceRaws.map((rawFinding) => {
    const adjudication = adjudicationsByRawFindingId.get(rawFinding.rawFindingId);
    if (adjudication === undefined) {
      throw new Error(
        `Anchor relevance authority is missing raw finding "${rawFinding.rawFindingId}"`,
      );
    }
    if (adjudication.decision !== 'relevant') {
      throw new Error(
        `Anchor relevance authority rejects raw finding "${rawFinding.rawFindingId}" with decision "${adjudication.decision}"`,
      );
    }
    return {
      rawFindingId: rawFinding.rawFindingId,
      rawIntegrityDigest: computeRawFindingIntegrityDigest(rawFinding),
      targetIdentityHash: rawFinding.targetIdentityHash,
      claimIdentityHash: rawFinding.claimIdentityHash,
      semanticClaimIdentityHash: rawFinding.semanticClaimIdentityHash,
      candidateIdentityHash: rawFinding.candidateIdentityHash,
      decision: adjudication.decision,
      managerOutputBinding: adjudication.managerOutputBinding,
    };
  });
  if (
    input.adjudications.length !== decisions.length
    || input.adjudications.some((adjudication) => (
      !adjudicationsByRawFindingId.has(adjudication.rawFindingId)
      || !absenceRaws.some((rawFinding) => (
        rawFinding.rawFindingId === adjudication.rawFindingId
      ))
    ))
  ) {
    throw new Error('Anchor relevance authority adjudications must exactly cover absence raw findings');
  }
  return createHash('sha256').update(canonicalJson({
    policy: 'anchor_relevance',
    operation: input.operation,
    decisions,
  })).digest('hex');
}
