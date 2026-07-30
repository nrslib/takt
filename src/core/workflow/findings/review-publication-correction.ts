import type { FindingLedger } from './types.js';
import {
  extractLenientRawFields,
  projectReviewerRawStructuredOutputWithEnvelope,
} from './raw-canonicalization.js';
import {
  checkReviewerEnvelope,
  estimateTokens,
  findRawFieldLimitViolation,
  RAW_FINDING_LIMITS,
} from './raw-finding-limits.js';

export interface FindingReviewPublicationCorrectionInput {
  readonly reportContent: string;
  readonly rawFindings: unknown;
}

export interface RelationClarificationLedgerProjection {
  readonly findings: readonly {
    readonly id: string;
    readonly status: string;
    readonly title: string | null;
    readonly target: unknown;
  }[];
}

function serializeJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  return serialized;
}

export function assertCorrectionRawFindingsWithinLimits(
  rawFindings: unknown,
  context: string,
): void {
  const serialized = serializeJson(rawFindings, `${context} rawFindings`);
  if (
    Buffer.byteLength(serialized, 'utf8')
    > RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes
  ) {
    throw new Error(
      `${context} rawFindings exceeded the per-reviewer JSON byte limit`,
    );
  }

  if (Array.isArray(rawFindings)) {
    const envelope = projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings,
    }).resourceEnvelope;
    const fields = rawFindings.map(extractLenientRawFields);
    const envelopeViolation = checkReviewerEnvelope({
      itemCount: envelope.itemCount,
      atomizedItemCount: fields.reduce(
        (total, item) => total + Math.max(1, item.targetFindingIds?.length ?? 0),
        0,
      ),
      jsonBytes: envelope.jsonBytes,
    });
    if (envelopeViolation !== undefined) {
      throw new Error(`${context} exceeded limits: ${envelopeViolation.reason}`);
    }
    const fieldViolation = fields
      .map(findRawFieldLimitViolation)
      .find((violation) => violation !== undefined);
    if (fieldViolation !== undefined) {
      throw new Error(`${context} field exceeded its limit: ${fieldViolation}`);
    }
  }

  if (estimateTokens(serialized) > RAW_FINDING_LIMITS.maxCorrectionOutputTokens) {
    throw new Error(`${context} rawFindings exceeded the correction token budget`);
  }
}

export function assertFindingReviewPublicationCorrectionInput(
  input: FindingReviewPublicationCorrectionInput,
  context: string,
): void {
  if (input.reportContent.length === 0) {
    throw new Error(`${context} reportContent is empty`);
  }
  assertCorrectionRawFindingsWithinLimits(input.rawFindings, context);
}

export function buildRelationClarificationLedgerProjection(
  ledger: FindingLedger,
): RelationClarificationLedgerProjection {
  if (ledger.findings.length > RAW_FINDING_LIMITS.maxRawFindingsPerStep) {
    throw new Error(
      'Relation clarification ledger projection exceeded the finding count limit',
    );
  }
  const projection: RelationClarificationLedgerProjection = {
    findings: ledger.findings.map((finding) => ({
      id: finding.id,
      status: finding.status,
      title: finding.title,
      target: finding.target ?? null,
    })),
  };
  if (
    Buffer.byteLength(serializeJson(projection, 'Relation clarification ledger projection'), 'utf8')
    > RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes
  ) {
    throw new Error(
      'Relation clarification ledger projection exceeded the JSON byte limit',
    );
  }
  return projection;
}
