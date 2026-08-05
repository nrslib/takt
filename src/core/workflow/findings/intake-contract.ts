import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  FindingSeverity,
  FindingTarget,
  IntakeContractAnomalyReasonCode,
  IntakeContractDefect,
  IntakeContractMissingRequirement,
  RawFindingEvidence,
  RawFindingRelation,
} from './types.js';
import { INTAKE_CONTRACT_CLASSIFICATION_AUTHORITY_ID } from '../../models/finding-types.js';

export interface IntakeContractObservation {
  relation: RawFindingRelation | null;
  target: FindingTarget;
  familyTag: string | null | undefined;
  severity: FindingSeverity | null | undefined;
  title: string | null | undefined;
  description: string | null | undefined;
  rawExcerpt?: string;
  evidence: readonly RawFindingEvidence[];
  evidenceCoverageGaps: readonly string[];
  reviewer: string;
  presentationLimit: number;
  lifecycleIntent: boolean;
  additionalReasonCodes?: readonly IntakeContractAnomalyReasonCode[];
  additionalMissingRequirements?: readonly IntakeContractMissingRequirement[];
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

export function intakeContractDefectFor(
  input: IntakeContractObservation,
): IntakeContractDefect | undefined {
  if (input.lifecycleIntent) {
    return undefined;
  }
  const missingRequirements: IntakeContractMissingRequirement[] = [
    ...(input.relation === null ? ['relation' as const] : []),
    ...(input.target.kind === 'review_scope' ? ['target' as const] : []),
    ...(input.familyTag === null || input.familyTag === undefined ? ['familyTag' as const] : []),
    ...(input.severity === null || input.severity === undefined ? ['severity' as const] : []),
    ...(input.title === null || input.title === undefined ? ['title' as const] : []),
    ...(input.description === null || input.description === undefined ? ['description' as const] : []),
    ...(input.evidence.length === 0 || input.evidenceCoverageGaps.length > 0
      ? ['claimEvidence' as const]
      : []),
    ...(input.additionalMissingRequirements ?? []),
  ];
  const reasonCodes: IntakeContractAnomalyReasonCode[] = [
    ...(missingRequirements.some((requirement) => requirement !== 'claimEvidence')
      ? ['product-identity-incomplete' as const]
      : []),
    ...(missingRequirements.includes('claimEvidence') ? ['claim-evidence-missing' as const] : []),
    ...(input.description === null || input.description === undefined
      ? input.rawExcerpt !== undefined
        ? ['normalizer-extraction-loss' as const]
        : []
      : []),
    ...(input.additionalReasonCodes ?? []),
  ];
  if (missingRequirements.length === 0 && reasonCodes.length === 0) {
    return undefined;
  }
  const hasClaimAnchor = Boolean(
    (input.rawExcerpt !== undefined && input.rawExcerpt.trim().length > 0)
    || (input.description !== undefined && input.description !== null
      && input.description.trim().length > 0)
    || (input.title !== undefined && input.title !== null && input.title.trim().length > 0)
    || input.relation !== null
    || input.target.kind !== 'review_scope'
    || input.evidence.length > 0,
  );
  return {
    observationClass: hasClaimAnchor ? 'claim-bearing' : 'protocol-noise',
    classificationAuthorityId: INTAKE_CONTRACT_CLASSIFICATION_AUTHORITY_ID,
    reasonCodes: sortedUniqueStrings(reasonCodes) as IntakeContractAnomalyReasonCode[],
    missingRequirements: sortedUniqueStrings(missingRequirements) as IntakeContractMissingRequirement[],
    presentationOwnerReviewer: input.reviewer,
    presentationLimit: Math.max(1, input.presentationLimit),
  };
}
