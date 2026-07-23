import type {
  FindingContractFixCoverage,
  FindingContractTeamLeaderDecision,
  PartDefinition,
  PartResult,
} from '../models/types.js';
import { ensureUniquePartIds } from './part-definition-validator.js';
import {
  parseFindingContractPartCompletionClaim,
  parseFindingContractPartDefinition,
  validateFindingContractPartBatch,
} from './team-leader-finding-contract.js';
import {
  requireBoundedString,
  requireExactKeys,
  requireNonEmptyString,
  requireObject,
  requireStringArray,
} from './team-leader-finding-contract-validation.js';

export class FindingContractTeamLeaderDecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingContractTeamLeaderDecisionValidationError';
  }
}

export function toFindingContractTeamLeaderDecisionValidationError(
  error: unknown,
): FindingContractTeamLeaderDecisionValidationError {
  if (error instanceof FindingContractTeamLeaderDecisionValidationError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FindingContractTeamLeaderDecisionValidationError(message);
}

function parseFixCoverage(
  raw: unknown,
  targetFindingIds: readonly string[],
  existingIds: readonly string[],
  plannedParts: readonly PartDefinition[],
): FindingContractFixCoverage[] {
  if (!Array.isArray(raw)) throw new Error('Finding Contract fixCoverage must be an array');
  const targetIds = new Set(targetFindingIds);
  const partIds = new Set(existingIds);
  const plannedPartsById = new Map(plannedParts.map((part) => [part.id, part]));
  const seen = new Set<string>();
  const coverage = raw.map((entry, index) => {
    const item = requireObject(entry, `fixCoverage[${index}]`);
    requireExactKeys(item, `fixCoverage[${index}]`, [
      'findingId', 'disposition', 'supportingPartIds', 'verificationPartIds',
    ]);
    const findingId = requireNonEmptyString(item.findingId, `fixCoverage[${index}].findingId`);
    if (!targetIds.has(findingId)) throw new Error(`fixCoverage references unknown finding "${findingId}"`);
    if (seen.has(findingId)) throw new Error(`fixCoverage contains duplicate finding "${findingId}"`);
    seen.add(findingId);
    const disposition = requireNonEmptyString(item.disposition, `fixCoverage[${index}].disposition`);
    if (disposition !== 'addressed' && disposition !== 'disputed') {
      throw new Error(`fixCoverage[${index}].disposition is invalid: ${disposition}`);
    }
    const parsedDisposition: 'addressed' | 'disputed' = disposition;
    const supportingPartIds = requireStringArray(
      item.supportingPartIds,
      `fixCoverage[${index}].supportingPartIds`,
      { nonEmpty: true },
    );
    const verificationPartIds = requireStringArray(
      item.verificationPartIds,
      `fixCoverage[${index}].verificationPartIds`,
    );
    for (const partId of [...supportingPartIds, ...verificationPartIds]) {
      if (!partIds.has(partId)) throw new Error(`fixCoverage references unknown part "${partId}"`);
      const assignment = plannedPartsById.get(partId)?.findingContract;
      if (assignment === undefined || !assignment.findingIds.includes(findingId)) {
        throw new Error(`fixCoverage part "${partId}" is not assigned to finding "${findingId}"`);
      }
    }
    return { findingId, disposition: parsedDisposition, supportingPartIds, verificationPartIds };
  });
  for (const findingId of targetIds) {
    if (!seen.has(findingId)) throw new Error(`fixCoverage does not cover actionable finding "${findingId}"`);
  }
  return coverage;
}

export function parseFindingContractTeamLeaderDecision(
  raw: unknown,
  targetFindingIds: readonly string[],
  existingIds: readonly string[],
  previouslyPlannedParts: readonly PartDefinition[],
): FindingContractTeamLeaderDecision {
  try {
    return parseFindingContractTeamLeaderDecisionUnchecked(
      raw,
      targetFindingIds,
      existingIds,
      previouslyPlannedParts,
    );
  } catch (error) {
    throw toFindingContractTeamLeaderDecisionValidationError(error);
  }
}

function parseFindingContractTeamLeaderDecisionUnchecked(
  raw: unknown,
  targetFindingIds: readonly string[],
  existingIds: readonly string[],
  previouslyPlannedParts: readonly PartDefinition[],
): FindingContractTeamLeaderDecision {
  const payload = requireObject(raw, 'Finding Contract Team Leader feedback');
  requireExactKeys(payload, 'Finding Contract Team Leader feedback', [
    'decision', 'reasoning', 'parts', 'fixCoverage', 'blockers',
  ]);
  const decision = requireNonEmptyString(payload.decision, 'Finding Contract Team Leader decision');
  const reasoning = requireBoundedString(payload.reasoning, 'Finding Contract Team Leader reasoning', 4000);
  if (!Array.isArray(payload.parts)) throw new Error('Finding Contract Team Leader parts must be an array');
  if (!Array.isArray(payload.fixCoverage)) throw new Error('Finding Contract Team Leader fixCoverage must be an array');
  const parts = payload.parts.map((entry, index) => parseFindingContractPartDefinition(entry, index));
  ensureUniquePartIds(parts);
  const blockers = requireStringArray(
    payload.blockers,
    'Finding Contract Team Leader blockers',
    { maxItems: 20, maxItemLength: 1000 },
  );
  if (decision === 'continue') {
    if (parts.length === 0) throw new Error('Finding Contract Team Leader continue decision requires at least one part');
    if (blockers.length > 0) throw new Error('Finding Contract Team Leader continue decision must not include blockers');
    if (payload.fixCoverage.length > 0) {
      throw new Error('Finding Contract Team Leader continue decision must not include fixCoverage');
    }
    validateFindingContractPartBatch(parts, targetFindingIds);
    const reusedId = parts.find((part) => existingIds.includes(part.id));
    if (reusedId !== undefined) {
      throw new Error(`Finding Contract Team Leader continue decision reuses existing part ID "${reusedId.id}"`);
    }
    return { decision, reasoning, parts };
  }
  if (parts.length > 0) throw new Error(`Finding Contract Team Leader ${decision} decision must not include parts`);
  if (decision === 'complete') {
    if (blockers.length > 0) throw new Error('Finding Contract Team Leader complete decision must not include blockers');
    return {
      decision,
      reasoning,
      parts: [],
      fixCoverage: parseFixCoverage(payload.fixCoverage, targetFindingIds, existingIds, previouslyPlannedParts),
    };
  }
  if (decision === 'replan') {
    if (blockers.length === 0) throw new Error('Finding Contract Team Leader replan decision requires blockers');
    if (payload.fixCoverage.length > 0) {
      throw new Error('Finding Contract Team Leader replan decision must not include fixCoverage');
    }
    return { decision, reasoning, parts: [], blockers };
  }
  throw new Error(`Finding Contract Team Leader decision is invalid: ${decision}`);
}

export function validateFindingContractCompletionEvidence(
  decision: Exclude<FindingContractTeamLeaderDecision, { decision: 'continue' | 'replan' }>,
  partResults: readonly PartResult[],
): void {
  try {
    validateFindingContractCompletionEvidenceUnchecked(decision, partResults);
  } catch (error) {
    throw toFindingContractTeamLeaderDecisionValidationError(error);
  }
}

function validateFindingContractCompletionEvidenceUnchecked(
  decision: Exclude<FindingContractTeamLeaderDecision, { decision: 'continue' | 'replan' }>,
  partResults: readonly PartResult[],
): void {
  const claimsByPartId = new Map(partResults.map((result) => [
    result.part.id,
    result.response.status === 'done'
      ? parseFindingContractPartCompletionClaim(result.response.structuredOutput, result.part)
      : undefined,
  ] as const));
  for (const coverage of decision.fixCoverage) {
    const hasSupportingClaim = coverage.supportingPartIds.some((partId) => (
      claimsByPartId.get(partId)?.findingOutcomes.some((outcome) => (
        outcome.findingId === coverage.findingId && outcome.outcome === coverage.disposition
      )) === true
    ));
    if (!hasSupportingClaim) {
      throw new Error(
        `fixCoverage for finding "${coverage.findingId}" has no supporting part claim for disposition "${coverage.disposition}"`,
      );
    }
    const evidencePartIds = [...new Set([
      ...coverage.supportingPartIds,
      ...coverage.verificationPartIds,
    ])];
    const evidenceClaims = evidencePartIds.map((partId) => ({ partId, claim: claimsByPartId.get(partId) }));
    const failedEvidence = evidenceClaims.find(({ claim }) => (
      claim?.checks.some((check) => check.status === 'failed') === true
    ));
    if (failedEvidence !== undefined) {
      throw new Error(`fixCoverage evidence part "${failedEvidence.partId}" contains a failed check`);
    }
    if (!evidenceClaims.some(({ claim }) => claim?.checks.some((check) => check.status === 'passed') === true)) {
      throw new Error(`fixCoverage for finding "${coverage.findingId}" has no passed verification check`);
    }
  }
}
