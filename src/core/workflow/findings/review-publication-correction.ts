import type { FindingLedger } from './types.js';
import {
  bindReviewerReportExcerpt,
  extractLenientRawFields,
  projectReviewerRawStructuredOutput,
  projectReviewerRawStructuredOutputWithEnvelope,
} from './raw-canonicalization.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
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

function projectedRawFindingRecords(
  rawFindings: unknown,
  context: string,
): Record<string, unknown>[] {
  if (!Array.isArray(rawFindings)) {
    throw new Error(`${context} rawFindings must be an array`);
  }
  const projected = projectReviewerRawStructuredOutput({ rawFindings }).rawFindings;
  if (!Array.isArray(projected)) {
    throw new Error(`${context} rawFindings projection failed`);
  }
  return projected as Record<string, unknown>[];
}

function differsByOneCodePoint(left: string, right: string): boolean {
  const leftPoints = [...left];
  const rightPoints = [...right];
  if (Math.abs(leftPoints.length - rightPoints.length) > 1) {
    return false;
  }
  if (leftPoints.length === rightPoints.length) {
    let differences = 0;
    for (let index = 0; index < leftPoints.length; index += 1) {
      if (leftPoints[index] !== rightPoints[index] && ++differences > 1) {
        return false;
      }
    }
    return differences === 1;
  }
  const [shorter, longer] = leftPoints.length < rightPoints.length
    ? [leftPoints, rightPoints]
    : [rightPoints, leftPoints];
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) {
      return false;
    }
    skipped = true;
    longerIndex += 1;
  }
  return true;
}

function projectedRecordKey(
  record: Record<string, unknown>,
  mutableCandidateFields: readonly string[],
): string {
  const candidate = record.candidate;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || Array.isArray(candidate)
  ) {
    return canonicalJson(record);
  }
  const fixedCandidate = { ...candidate } as Record<string, unknown>;
  for (const field of mutableCandidateFields) {
    delete fixedCandidate[field];
  }
  return canonicalJson({ ...record, candidate: fixedCandidate });
}

function projectedRawFindingId(record: Record<string, unknown>): string | undefined {
  const candidate = record.candidate;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || Array.isArray(candidate)
  ) {
    return undefined;
  }
  const rawFindingId = Reflect.get(candidate, 'rawFindingId');
  return typeof rawFindingId === 'string' ? rawFindingId : undefined;
}

export function findRelationClarificationContractViolation(
  originalRawFindings: unknown,
  correctedRawFindings: unknown,
  flaggedRawFindingIds: ReadonlySet<string>,
): string | undefined {
  let original: Record<string, unknown>[];
  let corrected: Record<string, unknown>[];
  try {
    original = projectedRawFindingRecords(originalRawFindings, 'Relation clarification input');
    corrected = projectedRawFindingRecords(correctedRawFindings, 'Relation clarification output');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (corrected.length !== original.length) {
    return `raw finding count changed from ${original.length} to ${corrected.length}`;
  }
  for (let index = 0; index < original.length; index += 1) {
    const originalRecord = original[index]!;
    const correctedRecord = corrected[index]!;
    const rawFindingId = projectedRawFindingId(originalRecord);
    const mutableFields = rawFindingId !== undefined && flaggedRawFindingIds.has(rawFindingId)
      ? ['relation', 'targetFindingIds']
      : [];
    if (
      projectedRecordKey(originalRecord, mutableFields)
      !== projectedRecordKey(correctedRecord, mutableFields)
    ) {
      return `regenerated output changed a protected field or order at rawFindings[${index}]`;
    }
  }
  return undefined;
}

/**
 * source binding 訂正を任意の本文再抽出に広げないための bounded recovery policy。
 * canonical projection 上の candidate を固定し、1 code point編集だけを許可する。
 */
export function assertSingleEditRawExcerptCorrectionContract(input: {
  readonly reportContent: string;
  readonly originalRawFindings: unknown;
  readonly correctedRawFindings: unknown;
  readonly correctedReportContent: unknown;
  readonly context: string;
}): void {
  if (input.correctedReportContent !== input.reportContent) {
    throw new Error(`${input.context} changed reportContent`);
  }
  const original = projectedRawFindingRecords(
    input.originalRawFindings,
    `${input.context} input`,
  );
  const corrected = projectedRawFindingRecords(
    input.correctedRawFindings,
    `${input.context} output`,
  );
  if (corrected.length !== original.length) {
    throw new Error(
      `${input.context} changed raw finding count from ${original.length} to ${corrected.length}`,
    );
  }
  for (let index = 0; index < original.length; index += 1) {
    const originalRecord = original[index]!;
    const correctedRecord = corrected[index]!;
    const { rawExcerpt: originalExcerpt, ...originalCandidate } = originalRecord;
    const { rawExcerpt: correctedExcerpt, ...correctedCandidate } = correctedRecord;
    if (canonicalJson(correctedCandidate) !== canonicalJson(originalCandidate)) {
      throw new Error(`${input.context} changed rawFindings[${index}].candidate`);
    }
    if (typeof originalExcerpt !== 'string' || typeof correctedExcerpt !== 'string') {
      throw new Error(`${input.context} rawFindings[${index}] requires rawExcerpt`);
    }
    let originalBindingIsValid = true;
    try {
      bindReviewerReportExcerpt(input.reportContent, originalExcerpt);
    } catch {
      originalBindingIsValid = false;
    }
    if (originalBindingIsValid && correctedExcerpt !== originalExcerpt) {
      throw new Error(`${input.context} changed valid rawFindings[${index}].rawExcerpt`);
    }
    if (
      !originalBindingIsValid
      && correctedExcerpt !== originalExcerpt
      && !differsByOneCodePoint(originalExcerpt, correctedExcerpt)
    ) {
      throw new Error(
        `${input.context} changed rawFindings[${index}].rawExcerpt by more than one character`,
      );
    }
  }
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
