import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type {
  FindingTarget,
  IntakeContractAnomalyReasonCode,
  IntakeContractDefect,
  IntakeContractMissingRequirement,
  RawFindingEvidence,
  RawFindingRelation,
} from './types.js';
import { INTAKE_CONTRACT_CLASSIFICATION_AUTHORITY_ID } from '../../models/finding-types.js';

/**
 * intake 契約の検査対象。
 *
 * レビュアーは観察専任なので、要件は「観察の実質」だけ — claim 本文
 * （description）、対象（target）、証拠の提示（claimEvidence）。severity /
 * title / familyTag は正規化係が claim 内容から付与する分類であり、relation は
 * 台帳を見る manager が裁定するため、どちらもレビュアーへ差し戻す理由にしない。
 * relation と title は claim の手がかり（hasClaimAnchor）としてだけ読む。
 */
export interface IntakeContractObservation {
  relation: RawFindingRelation | null;
  target: FindingTarget;
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
    ...(input.target.kind === 'review_scope' ? ['target' as const] : []),
    ...(input.description === null || input.description === undefined ? ['description' as const] : []),
    // claimEvidence は「レビュアーが claim evidence を一切提示しなかった」ときだけ欠落と
    // みなす。evidenceCoverageGaps は engine 側の issuance 診断（byte budget 枯渇・
    // source 再読の I/O 失敗・実在しない path 等）であり、gap が残っている時点で
    // レビュアーは evidence request を提示している。これを intake 契約違反として
    // reviewer anomaly（言い直し要求）へ送ると、engine のリソース事情をレビュアーの
    // 契約不履行に転嫁してしまうため、gap 付き raw は従来どおり admission 側の
    // fail-closed 経路（provisional）に残す。identity 不足があればそちらの欠落だけで
    // anomaly になる。
    ...(input.evidence.length === 0 && input.evidenceCoverageGaps.length === 0
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
