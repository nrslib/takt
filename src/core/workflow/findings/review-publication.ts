import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { REPORT_INTERNAL_NAMESPACE } from '../../models/reserved-report-names.js';
import {
  ensurePrivateDirectory,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
} from '../../../shared/utils/private-file.js';
import { runPrivateFileExclusive } from '../../../shared/utils/private-file-lock.js';
import { publishReportFile } from '../report-writer.js';
import {
  bindReviewerReportExcerpt,
  extractLenientRawFields,
  projectReviewerRawStructuredOutputWithEnvelope,
  type ReviewerRawResourceEnvelope,
} from './raw-canonicalization.js';
import {
  checkReviewerEnvelope,
  findRawFieldLimitViolation,
} from './raw-finding-limits.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import {
  FINDING_CLAIM_PROTOCOL_REVISION,
} from '../../../shared/prompts/finding-canonical-claim.js';
import { inspectCanonicalClaimPublication } from './canonical-claim-publication.js';

const PRIVATE_FILE_MODE = 0o600;

export const STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'structured',
  format: 'structured-output',
  protocolRevision: 1,
} as const);

export const CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'freeform',
  format: 'canonical-claim-blocks',
  protocolRevision: FINDING_CLAIM_PROTOCOL_REVISION,
} as const);

export type FindingReviewPublicationProtocol =
  | typeof STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL
  | typeof CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function freezeCanonicalFindingReviewPublication(
  publication: CanonicalFindingReviewPublication,
): CanonicalFindingReviewPublication {
  return deepFreeze(publication);
}

export interface FindingReviewPublicationIdentity {
  readonly scopeIdentity: string;
  readonly callNamespace: string;
  readonly parentStepName: string;
  readonly stepIteration: number;
  readonly reviewerStepName: string;
  readonly reportName: string;
}

export interface CanonicalFindingReviewPublication extends FindingReviewPublicationIdentity {
  readonly publicationId: string;
  readonly protocol: FindingReviewPublicationProtocol;
  readonly reportContent: string;
  readonly reportDigest: string;
  readonly rawFindings: readonly unknown[];
}

export interface FindingReviewPublicationPreparation {
  readonly publication: CanonicalFindingReviewPublication;
  readonly relationClarification?: ReviewerRelationClarification;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeFindingReviewPublicationId(
  identity: FindingReviewPublicationIdentity,
): string {
  return sha256(JSON.stringify([
    'finding-review-publication',
    identity.scopeIdentity,
    identity.callNamespace,
    identity.parentStepName,
    identity.stepIteration,
    identity.reviewerStepName,
    identity.reportName,
  ]));
}

function publicationRecordPath(
  reportDir: string,
  publicationId: string,
): string {
  return resolve(
    reportDir,
    REPORT_INTERNAL_NAMESPACE,
    'finding-review-publications',
    `${publicationId}.json`,
  );
}

function assertIdentityField(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Finding review publication requires ${field}`);
  }
}

function parsePublicationProtocol(value: unknown): FindingReviewPublicationProtocol {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Finding review publication requires protocol');
  }
  const record = value as Record<string, unknown>;
  const structured = STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  if (
    record.generationMode === structured.generationMode
    && record.format === structured.format
    && record.protocolRevision === structured.protocolRevision
  ) {
    return structured;
  }
  const canonicalBlocks = CANONICAL_BLOCKS_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  if (
    record.generationMode === canonicalBlocks.generationMode
    && record.format === canonicalBlocks.format
    && record.protocolRevision === canonicalBlocks.protocolRevision
  ) {
    return canonicalBlocks;
  }
  throw new Error('Finding review publication has an unsupported protocol descriptor');
}

function samePublicationProtocol(
  left: FindingReviewPublicationProtocol,
  right: FindingReviewPublicationProtocol,
): boolean {
  return left.generationMode === right.generationMode
    && left.format === right.format
    && left.protocolRevision === right.protocolRevision;
}

function parseStoredRelationClarification(
  value: unknown,
): ReviewerRelationClarification | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Finding review publication relationClarification is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.attempted !== true) {
    throw new Error('Finding review publication relationClarification requires attempted=true');
  }
  if (
    !Array.isArray(record.flaggedRawFindingIds)
    || !record.flaggedRawFindingIds.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      'Finding review publication relationClarification requires flaggedRawFindingIds',
    );
  }
  if (
    typeof record.priorAmbiguityCodesByRawId !== 'object'
    || record.priorAmbiguityCodesByRawId === null
    || Array.isArray(record.priorAmbiguityCodesByRawId)
    || !Object.values(record.priorAmbiguityCodesByRawId).every(
      (codes) => Array.isArray(codes) && codes.every((code) => typeof code === 'string'),
    )
  ) {
    throw new Error(
      'Finding review publication relationClarification requires priorAmbiguityCodesByRawId',
    );
  }
  return structuredClone(value) as ReviewerRelationClarification;
}

function parseStoredPreparation(
  content: Buffer,
  expectedPublicationId: string,
): FindingReviewPublicationPreparation {
  const parsed: unknown = JSON.parse(content.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Finding review publication "${expectedPublicationId}" is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.publication !== 'object'
    || record.publication === null
    || Array.isArray(record.publication)
  ) {
    throw new Error(`Finding review publication "${expectedPublicationId}" has no publication`);
  }
  const publicationRecord = record.publication as Record<string, unknown>;
  assertIdentityField(publicationRecord.publicationId, 'publicationId');
  assertIdentityField(publicationRecord.scopeIdentity, 'scopeIdentity');
  if (typeof publicationRecord.callNamespace !== 'string') {
    throw new Error('Finding review publication requires callNamespace');
  }
  assertIdentityField(publicationRecord.parentStepName, 'parentStepName');
  if (
    !Number.isSafeInteger(publicationRecord.stepIteration)
    || Number(publicationRecord.stepIteration) <= 0
  ) {
    throw new Error('Finding review publication requires a positive stepIteration');
  }
  assertIdentityField(publicationRecord.reviewerStepName, 'reviewerStepName');
  assertIdentityField(publicationRecord.reportName, 'reportName');
  assertIdentityField(publicationRecord.reportContent, 'reportContent');
  assertIdentityField(publicationRecord.reportDigest, 'reportDigest');
  if (!Array.isArray(publicationRecord.rawFindings)) {
    throw new Error('Finding review publication requires rawFindings');
  }
  const publication: CanonicalFindingReviewPublication = {
    publicationId: publicationRecord.publicationId,
    scopeIdentity: publicationRecord.scopeIdentity,
    callNamespace: publicationRecord.callNamespace,
    parentStepName: publicationRecord.parentStepName,
    stepIteration: Number(publicationRecord.stepIteration),
    reviewerStepName: publicationRecord.reviewerStepName,
    reportName: publicationRecord.reportName,
    protocol: parsePublicationProtocol(publicationRecord.protocol),
    reportContent: publicationRecord.reportContent,
    reportDigest: publicationRecord.reportDigest,
    rawFindings: publicationRecord.rawFindings,
  };
  assertCanonicalFindingReviewPublication(publication);
  if (publication.protocol.format === 'canonical-claim-blocks') {
    const inspection = inspectCanonicalClaimPublication(
      publication.reportContent,
      publication.rawFindings,
    );
    if (!inspection.valid) {
      throw new Error(
        `Stored finding review publication canonical claim invariant failed: ${
          inspection.detail ?? 'invalid canonical claim publication'
        }`,
      );
    }
  }
  if (publication.publicationId !== expectedPublicationId) {
    throw new Error(`Finding review publication identity mismatch for "${expectedPublicationId}"`);
  }
  const relationClarification = parseStoredRelationClarification(
    record.relationClarification,
  );
  return {
    publication: freezeCanonicalFindingReviewPublication(publication),
    ...(relationClarification !== undefined ? { relationClarification } : {}),
  };
}

function assertPublicationRawFindings(
  reportContent: string,
  rawFindings: readonly unknown[],
  sourceEnvelope?: ReviewerRawResourceEnvelope,
): void {
  const resourceEnvelope = sourceEnvelope
    ?? projectReviewerRawStructuredOutputWithEnvelope({ rawFindings }).resourceEnvelope;
  const fields = rawFindings.map(extractLenientRawFields);
  const atomizedItemCount = fields.reduce(
    (total, item) => total + Math.max(1, item.targetFindingIds?.length ?? 0),
    0,
  );
  const envelopeViolation = checkReviewerEnvelope({
    itemCount: resourceEnvelope.itemCount,
    atomizedItemCount,
    jsonBytes: resourceEnvelope.jsonBytes,
  });
  if (envelopeViolation !== undefined) {
    throw new Error(`Finding review publication exceeded limits: ${envelopeViolation.reason}`);
  }
  const fieldViolation = fields
    .map(findRawFieldLimitViolation)
    .find((violation) => violation !== undefined);
  if (fieldViolation !== undefined) {
    throw new Error(`Finding review publication field exceeded its limit: ${fieldViolation}`);
  }

  for (const [index, item] of rawFindings.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Finding review publication rawFindings[${index}] is not an object`);
    }
    const rawExcerpt = Reflect.get(item, 'rawExcerpt');
    if (typeof rawExcerpt !== 'string' || rawExcerpt.length === 0) {
      throw new Error(`Finding review publication rawFindings[${index}] requires rawExcerpt`);
    }
    bindReviewerReportExcerpt(reportContent, rawExcerpt);
  }
}

export function assertCanonicalFindingReviewPublication(
  publication: CanonicalFindingReviewPublication,
): void {
  parsePublicationProtocol(publication.protocol);
  const expectedId = computeFindingReviewPublicationId(publication);
  if (publication.publicationId !== expectedId) {
    throw new Error(`Finding review publication identity mismatch for "${publication.publicationId}"`);
  }
  const reportDigest = sha256(Buffer.from(publication.reportContent, 'utf8'));
  if (publication.reportDigest !== reportDigest) {
    throw new Error(`Finding review publication digest mismatch for "${publication.publicationId}"`);
  }
  assertPublicationRawFindings(publication.reportContent, publication.rawFindings);
}

export function createFindingReviewPublication(input: {
  readonly identity: FindingReviewPublicationIdentity;
  readonly protocol: FindingReviewPublicationProtocol;
  readonly reportContent: string;
  readonly rawFindings: readonly unknown[];
  readonly reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
}): CanonicalFindingReviewPublication {
  const publication: CanonicalFindingReviewPublication = {
    ...input.identity,
    publicationId: computeFindingReviewPublicationId(input.identity),
    protocol: input.protocol,
    reportContent: input.reportContent,
    reportDigest: sha256(Buffer.from(input.reportContent, 'utf8')),
    rawFindings: structuredClone(input.rawFindings),
  };
  assertPublicationRawFindings(
    publication.reportContent,
    publication.rawFindings,
    input.reviewerRawResourceEnvelope,
  );
  assertCanonicalFindingReviewPublication(publication);
  return freezeCanonicalFindingReviewPublication(publication);
}

export function loadFindingReviewPublication(
  reportDir: string,
  identity: FindingReviewPublicationIdentity,
  expectedProtocol: FindingReviewPublicationProtocol,
): FindingReviewPublicationPreparation | undefined {
  const publicationId = computeFindingReviewPublicationId(identity);
  const path = publicationRecordPath(reportDir, publicationId);
  ensurePrivateDirectory(dirname(path));
  const snapshot = readPrivateFileState(path);
  if (!snapshot.state.exists) {
    return undefined;
  }
  if (!('content' in snapshot)) {
    throw new Error(`Finding review publication content is missing: ${path}`);
  }
  const preparation = parseStoredPreparation(snapshot.content, publicationId);
  if (!samePublicationProtocol(preparation.publication.protocol, expectedProtocol)) {
    throw new Error(
      `Finding review publication protocol mismatch for "${publicationId}"`,
    );
  }
  return preparation;
}

export function persistFindingReviewPublication(
  reportDir: string,
  preparation: FindingReviewPublicationPreparation,
): FindingReviewPublicationPreparation {
  const { publication } = preparation;
  assertCanonicalFindingReviewPublication(publication);
  const path = publicationRecordPath(reportDir, publication.publicationId);
  ensurePrivateDirectory(dirname(path));
  return runPrivateFileExclusive(`${path}.lock`, () => {
    const snapshot = readPrivateFileState(path);
    if (snapshot.state.exists) {
      if (!('content' in snapshot)) {
        throw new Error(`Finding review publication content is missing: ${path}`);
      }
      const existing = parseStoredPreparation(snapshot.content, publication.publicationId);
      if (
        existing.publication.reportDigest !== publication.reportDigest
        || !samePublicationProtocol(existing.publication.protocol, publication.protocol)
      ) {
        throw new Error(
          `Finding review publication conflict for "${publication.publicationId}"`,
        );
      }
      return existing;
    }
    writeNewPrivateFileWithMode(
      path,
      JSON.stringify(preparation),
      PRIVATE_FILE_MODE,
    );
    return preparation;
  });
}

export function publishFindingReviewPublication(
  reportDir: string,
  publication: CanonicalFindingReviewPublication,
): void {
  assertCanonicalFindingReviewPublication(publication);
  publishReportFile({
    reportDir,
    fileName: publication.reportName,
    content: publication.reportContent,
    publicationId: publication.publicationId,
    contentSha256: publication.reportDigest,
  });
}
