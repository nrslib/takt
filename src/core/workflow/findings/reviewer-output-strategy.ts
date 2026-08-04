import type {
  FindingContractConfig,
} from '../../models/finding-types.js';
import type { FindingIntakeNormalizeConfig } from '../../models/config-types.js';
import type { StepProviderInfo } from '../types.js';
import type {
  FindingContractReviewerOutputStrategy,
} from '../instruction/instruction-context.js';
import { findingIntakeNormalizerTargetsStep } from './intake-normalize-policy.js';

const STRATEGIES = Object.freeze({
  structured: Object.freeze({
    kind: 'structured',
    reportGeneration: 'structured',
    intake: 'reviewer_structured',
  }),
  plain_text_normalized: Object.freeze({
    kind: 'plain_text_normalized',
    reportGeneration: 'plain_text',
    intake: 'isolated_normalizer',
  }),
});

export function resolveFindingContractReviewerOutputStrategy(
  contract: FindingContractConfig | undefined,
  intakeNormalize: FindingIntakeNormalizeConfig | undefined,
  reviewerProviderInfo: StepProviderInfo,
): FindingContractReviewerOutputStrategy | undefined {
  if (contract === undefined) {
    return undefined;
  }
  return findingIntakeNormalizerTargetsStep(
    intakeNormalize,
    reviewerProviderInfo,
  )
    ? STRATEGIES.plain_text_normalized
    : STRATEGIES.structured;
}
