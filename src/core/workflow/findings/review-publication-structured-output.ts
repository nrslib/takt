import type { WorkflowStructuredOutput } from '../../models/types.js';
import {
  RawFindingsOutputValidationJsonSchema,
  createRawFindingsOutputJsonSchema,
} from './schemas.js';

export const FINDING_REVIEW_PUBLICATION_SCHEMA_REF =
  'takt://schemas/finding-review-publication';

const ReportContentJsonSchema = {
  type: 'string',
  minLength: 1,
} as const;

export function createFindingReviewPublicationStructuredOutput(): WorkflowStructuredOutput {
  const rawFindingsSchema = createRawFindingsOutputJsonSchema();
  return {
    schemaRef: FINDING_REVIEW_PUBLICATION_SCHEMA_REF,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['reportContent', 'rawFindings'],
      properties: {
        reportContent: ReportContentJsonSchema,
        rawFindings: rawFindingsSchema.properties.rawFindings,
      },
    },
    validationSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reportContent', 'rawFindings'],
      properties: {
        reportContent: ReportContentJsonSchema,
        rawFindings: RawFindingsOutputValidationJsonSchema.properties.rawFindings,
      },
    },
  };
}

export function findingReviewPublicationReportContent(
  structuredOutput: Record<string, unknown> | undefined,
): string | undefined {
  if (structuredOutput === undefined) {
    return undefined;
  }
  const reportContent = structuredOutput.reportContent;
  return typeof reportContent === 'string' && reportContent.trim().length > 0
    ? reportContent
    : undefined;
}
