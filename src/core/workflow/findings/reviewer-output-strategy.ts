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
  structured: Object.freeze({ kind: 'structured' }),
  canonical_blocks: Object.freeze({ kind: 'canonical_blocks' }),
});

export function resolveFindingContractReviewerOutputStrategy(
  contract: FindingContractConfig | undefined,
): FindingContractReviewerOutputStrategy | undefined {
  return contract === undefined ? undefined : STRATEGIES[contract.reviewerOutput];
}
