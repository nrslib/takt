import type {
  FindingContractConfig,
  FindingContractReviewerOutput,
} from '../../models/finding-types.js';
import type {
  FindingContractReviewerOutputStrategy,
} from '../instruction/instruction-context.js';

const STRATEGIES: Readonly<
  Record<FindingContractReviewerOutput, FindingContractReviewerOutputStrategy>
> = Object.freeze({
  structured: Object.freeze({
    kind: 'structured',
    reportGeneration: 'structured',
    intake: 'reviewer_structured',
  }),
  canonical_blocks: Object.freeze({
    kind: 'canonical_blocks',
    reportGeneration: 'plain_text',
    intake: 'canonical_parser',
  }),
  plain_text_normalized: Object.freeze({
    kind: 'plain_text_normalized',
    reportGeneration: 'plain_text',
    intake: 'isolated_normalizer',
  }),
});

export function resolveFindingContractReviewerOutputStrategy(
  contract: FindingContractConfig | undefined,
): FindingContractReviewerOutputStrategy | undefined {
  return contract === undefined ? undefined : STRATEGIES[contract.reviewerOutput];
}
