import type { PartResult } from '../models/types.js';
import { parseFindingContractPartCompletionClaim } from './team-leader-finding-contract.js';
import { FindingContractInputValidationError } from './team-leader-finding-contract-validation.js';

export interface FindingContractEvidenceEntry {
  readonly findingId: string;
  readonly partId: string;
  readonly role: 'diagnose' | 'repair' | 'verify';
  readonly status: string;
  readonly claimedDisposition?: 'addressed' | 'disputed' | 'blocked';
  readonly passedChecks: number;
  readonly failedChecks: number;
  readonly usableAsSupportFor: readonly ('addressed' | 'disputed')[];
  readonly usableAsVerification: boolean;
  readonly supportIneligibleReasons: readonly string[];
  readonly verificationIneligibleReasons: readonly string[];
  readonly claimValidationError?: string;
}

export interface FindingContractEvidenceFinding {
  readonly findingId: string;
  readonly eligibleSupportingPartIds: Readonly<{
    addressed: readonly string[];
    disputed: readonly string[];
  }>;
  readonly eligibleVerificationPartIds: readonly string[];
  readonly completeFeasible: boolean;
}

export interface FindingContractDecisionEvidenceSnapshot {
  readonly entries: readonly FindingContractEvidenceEntry[];
  readonly findings: readonly FindingContractEvidenceFinding[];
}

export function buildFindingContractDecisionEvidenceSnapshot(
  partResults: readonly PartResult[],
  targetFindingIds: readonly string[],
): FindingContractDecisionEvidenceSnapshot {
  const entries: FindingContractEvidenceEntry[] = [];
  for (const result of partResults) {
    const assignment = result.part.findingContract;
    if (assignment === undefined) {
      throw new Error(`Part "${result.part.id}" is missing findingContract assignment`);
    }
    if (result.response.status !== 'done') {
      for (const findingId of assignment.findingIds) {
        entries.push({
          findingId,
          partId: result.part.id,
          role: assignment.role,
          status: result.response.status,
          passedChecks: 0,
          failedChecks: 0,
          usableAsSupportFor: [],
          usableAsVerification: false,
          supportIneligibleReasons: [`part_status:${result.response.status}`],
          verificationIneligibleReasons: [`part_status:${result.response.status}`],
        });
      }
      continue;
    }
    let claim: ReturnType<typeof parseFindingContractPartCompletionClaim>;
    try {
      claim = parseFindingContractPartCompletionClaim(result.response.structuredOutput, result.part);
    } catch (error) {
      if (!(error instanceof FindingContractInputValidationError)) throw error;
      for (const findingId of assignment.findingIds) {
        entries.push({
          findingId,
          partId: result.part.id,
          role: assignment.role,
          status: result.response.status,
          passedChecks: 0,
          failedChecks: 0,
          usableAsSupportFor: [],
          usableAsVerification: false,
          supportIneligibleReasons: ['invalid_claim'],
          verificationIneligibleReasons: ['invalid_claim'],
          claimValidationError: error.message,
        });
      }
      continue;
    }
    const passedChecks = claim.checks.filter((check) => check.status === 'passed').length;
    const failedChecks = claim.checks.filter((check) => check.status === 'failed').length;
    for (const findingId of assignment.findingIds) {
      const outcome = claim.findingOutcomes.find((candidate) => candidate.findingId === findingId);
      const usableAsSupportFor = outcome !== undefined
        && outcome.outcome !== 'blocked'
        && failedChecks === 0
        ? [outcome.outcome]
        : [];
      const usableAsVerification = passedChecks > 0 && failedChecks === 0;
      const supportIneligibleReasons = [
        ...(outcome === undefined ? ['missing_outcome'] : []),
        ...(outcome?.outcome === 'blocked' ? ['blocked_outcome'] : []),
        ...(failedChecks > 0 ? ['failed_check'] : []),
      ];
      const verificationIneligibleReasons = [
        ...(failedChecks > 0 ? ['failed_check'] : []),
        ...(passedChecks === 0 ? ['no_passed_check'] : []),
      ];
      entries.push({
        findingId,
        partId: result.part.id,
        role: assignment.role,
        status: result.response.status,
        ...(outcome === undefined ? {} : { claimedDisposition: outcome.outcome }),
        passedChecks,
        failedChecks,
        usableAsSupportFor,
        usableAsVerification,
        supportIneligibleReasons,
        verificationIneligibleReasons,
      });
    }
  }
  const sortedEntries = entries.sort((left, right) => (
    left.findingId.localeCompare(right.findingId) || left.partId.localeCompare(right.partId)
  ));
  const findings = [...targetFindingIds]
    .sort()
    .map((findingId): FindingContractEvidenceFinding => {
      const findingEntries = sortedEntries.filter((entry) => entry.findingId === findingId);
      const addressed = findingEntries
        .filter((entry) => entry.usableAsSupportFor.includes('addressed'))
        .map((entry) => entry.partId);
      const disputed = findingEntries
        .filter((entry) => entry.usableAsSupportFor.includes('disputed'))
        .map((entry) => entry.partId);
      const verification = findingEntries
        .filter((entry) => entry.usableAsVerification)
        .map((entry) => entry.partId);
      return {
        findingId,
        eligibleSupportingPartIds: {
          addressed,
          disputed,
        },
        eligibleVerificationPartIds: verification,
        completeFeasible: verification.length > 0 && (addressed.length > 0 || disputed.length > 0),
      };
    });
  return {
    entries: sortedEntries,
    findings,
  };
}
