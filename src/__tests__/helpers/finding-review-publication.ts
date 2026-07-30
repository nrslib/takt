import {
  createFindingReviewPublication,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  type CanonicalFindingReviewPublication,
} from '../../core/workflow/findings/review-publication.js';
import type { ReviewerRawResourceEnvelope } from '../../core/workflow/findings/raw-canonicalization.js';

export function findingReviewPublicationFixture(input: {
  readonly scopeIdentity: string;
  readonly parentStepName: string;
  readonly stepIteration: number;
  readonly reviewerStepName: string;
  readonly rawFindings: readonly unknown[];
  readonly reportContent?: string;
  readonly callNamespace?: string;
  readonly reportName?: string;
  readonly reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
}): CanonicalFindingReviewPublication {
  const reportContent = input.reportContent
    ?? input.rawFindings
      .map((item) => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? Reflect.get(item, 'rawExcerpt')
          : undefined
      ))
      .filter((excerpt): excerpt is string => typeof excerpt === 'string')
      .join('\n');
  return createFindingReviewPublication({
    identity: {
      scopeIdentity: input.scopeIdentity,
      callNamespace: input.callNamespace ?? '',
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      reviewerStepName: input.reviewerStepName,
      reportName: input.reportName ?? `${input.reviewerStepName}.md`,
    },
    protocol: STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    reportContent,
    rawFindings: input.rawFindings,
    ...(input.reviewerRawResourceEnvelope !== undefined
      ? { reviewerRawResourceEnvelope: input.reviewerRawResourceEnvelope }
      : {}),
  });
}
