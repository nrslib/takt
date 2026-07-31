import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
  REPORT_INTERNAL_NAMESPACE,
  RESUME_ARTIFACTS_FILE_NAME,
} from '../../models/reserved-report-names.js';
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
import { isProviderType, type ProviderType } from '../../../shared/types/provider.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';

const PRIVATE_FILE_MODE = 0o600;
const STORED_PUBLICATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;

export const STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'structured',
  format: 'structured-output',
  protocolRevision: 1,
} as const);

export const PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'freeform',
  format: 'normalized-plain-text',
  protocolRevision: 1,
} as const);

export type FindingReviewPublicationProtocol =
  | typeof STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL
  | typeof PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;

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
  readonly reviewerExecutionIdentity?: ReviewerExecutionIdentity;
}

export interface ReviewerExecutionIdentity {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly providerOptions?: StepProviderOptions;
}

export interface PendingFindingReviewNormalization
  extends FindingReviewPublicationIdentity {
  readonly workflowName: string;
  readonly publicationId: string;
  readonly protocol: typeof PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  readonly reportContent: string;
  readonly reportDigest: string;
  readonly reviewerExecutionIdentity: ReviewerExecutionIdentity;
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
    FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
    `${publicationId}.json`,
  );
}

function pendingNormalizationRecordPath(
  reportDir: string,
  publicationId: string,
): string {
  return resolve(
    reportDir,
    REPORT_INTERNAL_NAMESPACE,
    FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
    'pending',
    `${publicationId}.json`,
  );
}

function inheritedSnapshotExists(reportDir: string): boolean {
  return readPrivateFileState(
    resolve(reportDir, RESUME_ARTIFACTS_FILE_NAME),
  ).state.exists;
}

function readStoredRecordContents(
  directory: string,
): Array<{ publicationId: string; content: Buffer }> {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return names.flatMap((name) => {
    const match = STORED_PUBLICATION_FILE_PATTERN.exec(name);
    if (match === null) {
      return [];
    }
    const snapshot = readPrivateFileState(resolve(directory, name));
    if (!snapshot.state.exists) {
      return [];
    }
    if (!('content' in snapshot)) {
      throw new Error(`Finding review publication content is missing: ${directory}/${name}`);
    }
    return [{
      publicationId: match[1]!,
      content: snapshot.content,
    }];
  });
}

function samePublicationIdentityExceptScope(
  left: FindingReviewPublicationIdentity,
  right: FindingReviewPublicationIdentity,
): boolean {
  return left.callNamespace === right.callNamespace
    && left.parentStepName === right.parentStepName
    && left.stepIteration === right.stepIteration
    && left.reviewerStepName === right.reviewerStepName
    && left.reportName === right.reportName;
}

function preparationContentIdentity(
  preparation: FindingReviewPublicationPreparation,
): string {
  return sha256(JSON.stringify({
    protocol: preparation.publication.protocol,
    reportDigest: preparation.publication.reportDigest,
    rawFindings: preparation.publication.rawFindings,
    relationClarification: preparation.relationClarification ?? null,
    reviewerExecutionIdentity: preparation.reviewerExecutionIdentity ?? null,
  }));
}

function rebindInheritedFindingReviewPublication(
  reportDir: string,
  identity: FindingReviewPublicationIdentity,
  expectedProtocol?: FindingReviewPublicationProtocol,
): FindingReviewPublicationPreparation | undefined {
  if (!inheritedSnapshotExists(reportDir)) {
    return undefined;
  }
  const directory = resolve(
    reportDir,
    REPORT_INTERNAL_NAMESPACE,
    FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
  );
  const candidates = readStoredRecordContents(directory)
    .map(({ publicationId, content }) => (
      parseStoredPreparation(content, publicationId)
    ))
    .filter(({ publication }) => (
      samePublicationIdentityExceptScope(publication, identity)
    ));
  if (candidates.length === 0) {
    return undefined;
  }
  const first = candidates[0]!;
  const contentIdentity = preparationContentIdentity(first);
  if (
    candidates.some((candidate) => (
      preparationContentIdentity(candidate) !== contentIdentity
    ))
  ) {
    throw new Error(
      `Inherited finding review publication is ambiguous for "${identity.reviewerStepName}"`,
    );
  }
  if (
    expectedProtocol !== undefined
    && !samePublicationProtocol(first.publication.protocol, expectedProtocol)
  ) {
    throw new Error(
      `Inherited finding review publication protocol mismatch for "${identity.reviewerStepName}"`,
    );
  }
  const rebound: FindingReviewPublicationPreparation = {
    publication: createFindingReviewPublication({
      identity,
      protocol: first.publication.protocol,
      reportContent: first.publication.reportContent,
      rawFindings: first.publication.rawFindings,
    }),
    ...(first.relationClarification === undefined
      ? {}
      : { relationClarification: first.relationClarification }),
    ...(first.reviewerExecutionIdentity === undefined
      ? {}
      : { reviewerExecutionIdentity: first.reviewerExecutionIdentity }),
  };
  return persistFindingReviewPublication(reportDir, rebound);
}

function pendingContentIdentity(
  pending: PendingFindingReviewNormalization,
): string {
  return sha256(JSON.stringify({
    workflowName: pending.workflowName,
    protocol: pending.protocol,
    reportDigest: pending.reportDigest,
    reviewerExecutionIdentity: pending.reviewerExecutionIdentity,
  }));
}

function rebindInheritedPendingFindingReviewNormalization(
  reportDir: string,
  identity: FindingReviewPublicationIdentity,
  expectedWorkflowName: string,
): PendingFindingReviewNormalization | undefined {
  if (!inheritedSnapshotExists(reportDir)) {
    return undefined;
  }
  const directory = resolve(
    reportDir,
    REPORT_INTERNAL_NAMESPACE,
    FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
    'pending',
  );
  const candidates = readStoredRecordContents(directory)
    .map(({ publicationId, content }) => (
      parseStoredPendingNormalization(content, publicationId)
    ))
    .filter((pending) => samePublicationIdentityExceptScope(pending, identity));
  if (candidates.length === 0) {
    return undefined;
  }
  const first = candidates[0]!;
  const contentIdentity = pendingContentIdentity(first);
  if (
    candidates.some((candidate) => pendingContentIdentity(candidate) !== contentIdentity)
  ) {
    throw new Error(
      `Inherited pending finding review normalization is ambiguous for "${identity.reviewerStepName}"`,
    );
  }
  if (first.workflowName !== expectedWorkflowName) {
    throw new Error(
      `Inherited pending finding review normalization workflow mismatch for "${identity.reviewerStepName}"`,
    );
  }
  return persistPendingFindingReviewNormalization(
    reportDir,
    createPendingFindingReviewNormalization({
      identity,
      workflowName: expectedWorkflowName,
      reportContent: first.reportContent,
      reviewerExecutionIdentity: first.reviewerExecutionIdentity,
    }),
  );
}

function parseReviewerExecutionIdentity(value: unknown): ReviewerExecutionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Finding review publication requires reviewerExecutionIdentity');
  }
  const record = value as Record<string, unknown>;
  if (!isProviderType(record.provider)) {
    throw new Error('Finding review publication reviewerExecutionIdentity requires provider');
  }
  if (record.model !== undefined && typeof record.model !== 'string') {
    throw new Error('Finding review publication reviewerExecutionIdentity model is not a string');
  }
  if (
    record.providerOptions !== undefined
    && (
      typeof record.providerOptions !== 'object'
      || record.providerOptions === null
      || Array.isArray(record.providerOptions)
    )
  ) {
    throw new Error(
      'Finding review publication reviewerExecutionIdentity providerOptions is not an object',
    );
  }
  return deepFreeze({
    provider: record.provider,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.providerOptions !== undefined
      ? { providerOptions: structuredClone(record.providerOptions) as StepProviderOptions }
      : {}),
  });
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
  const plainTextNormalized = PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  if (
    record.generationMode === plainTextNormalized.generationMode
    && record.format === plainTextNormalized.format
    && record.protocolRevision === plainTextNormalized.protocolRevision
  ) {
    return plainTextNormalized;
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
  if (publication.publicationId !== expectedPublicationId) {
    throw new Error(`Finding review publication identity mismatch for "${expectedPublicationId}"`);
  }
  const relationClarification = parseStoredRelationClarification(
    record.relationClarification,
  );
  const reviewerExecutionIdentity = record.reviewerExecutionIdentity === undefined
    ? undefined
    : parseReviewerExecutionIdentity(record.reviewerExecutionIdentity);
  if (reviewerExecutionIdentity === undefined) {
    throw new Error(
      `Finding review publication "${expectedPublicationId}" requires reviewerExecutionIdentity`,
    );
  }
  return {
    publication: freezeCanonicalFindingReviewPublication(publication),
    ...(relationClarification !== undefined ? { relationClarification } : {}),
    ...(reviewerExecutionIdentity !== undefined ? { reviewerExecutionIdentity } : {}),
  };
}

function assertPendingFindingReviewNormalization(
  pending: PendingFindingReviewNormalization,
): void {
  assertIdentityField(pending.workflowName, 'workflowName');
  const expectedId = computeFindingReviewPublicationId(pending);
  if (pending.publicationId !== expectedId) {
    throw new Error(
      `Pending finding review normalization identity mismatch for "${pending.publicationId}"`,
    );
  }
  if (!samePublicationProtocol(
    pending.protocol,
    PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  )) {
    throw new Error(
      `Pending finding review normalization protocol mismatch for "${pending.publicationId}"`,
    );
  }
  const reportDigest = sha256(Buffer.from(pending.reportContent, 'utf8'));
  if (pending.reportDigest !== reportDigest) {
    throw new Error(
      `Pending finding review normalization digest mismatch for "${pending.publicationId}"`,
    );
  }
  parseReviewerExecutionIdentity(pending.reviewerExecutionIdentity);
}

function parseStoredPendingNormalization(
  content: Buffer,
  expectedPublicationId: string,
): PendingFindingReviewNormalization {
  const parsed: unknown = JSON.parse(content.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Pending finding review normalization "${expectedPublicationId}" is not an object`,
    );
  }
  const record = parsed as Record<string, unknown>;
  assertIdentityField(record.publicationId, 'publicationId');
  assertIdentityField(record.workflowName, 'workflowName');
  assertIdentityField(record.scopeIdentity, 'scopeIdentity');
  if (typeof record.callNamespace !== 'string') {
    throw new Error('Pending finding review normalization requires callNamespace');
  }
  assertIdentityField(record.parentStepName, 'parentStepName');
  if (!Number.isSafeInteger(record.stepIteration) || Number(record.stepIteration) <= 0) {
    throw new Error(
      'Pending finding review normalization requires a positive stepIteration',
    );
  }
  assertIdentityField(record.reviewerStepName, 'reviewerStepName');
  assertIdentityField(record.reportName, 'reportName');
  assertIdentityField(record.reportContent, 'reportContent');
  assertIdentityField(record.reportDigest, 'reportDigest');
  const protocol = parsePublicationProtocol(record.protocol);
  if (protocol.format !== 'normalized-plain-text') {
    throw new Error(
      `Pending finding review normalization "${expectedPublicationId}" has an unsupported protocol`,
    );
  }
  const pending: PendingFindingReviewNormalization = {
    publicationId: record.publicationId,
    workflowName: record.workflowName,
    scopeIdentity: record.scopeIdentity,
    callNamespace: record.callNamespace,
    parentStepName: record.parentStepName,
    stepIteration: Number(record.stepIteration),
    reviewerStepName: record.reviewerStepName,
    reportName: record.reportName,
    protocol,
    reportContent: record.reportContent,
    reportDigest: record.reportDigest,
    reviewerExecutionIdentity: parseReviewerExecutionIdentity(
      record.reviewerExecutionIdentity,
    ),
  };
  assertPendingFindingReviewNormalization(pending);
  if (pending.publicationId !== expectedPublicationId) {
    throw new Error(
      `Pending finding review normalization identity mismatch for "${expectedPublicationId}"`,
    );
  }
  return deepFreeze(pending);
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

  assertFindingReviewPublicationSourceBindings(reportContent, rawFindings);
}

export class FindingReviewPublicationSourceBindingError extends Error {
  readonly rawFindingIndex: number;

  constructor(rawFindingIndex: number, detail: string, cause?: unknown) {
    super(
      `Finding review publication rawFindings[${rawFindingIndex}] has invalid source binding: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'FindingReviewPublicationSourceBindingError';
    this.rawFindingIndex = rawFindingIndex;
  }
}

export function assertFindingReviewPublicationSourceBindings(
  reportContent: string,
  rawFindings: readonly unknown[],
): void {
  for (const [index, item] of rawFindings.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new FindingReviewPublicationSourceBindingError(index, 'item is not an object');
    }
    const rawExcerpt = Reflect.get(item, 'rawExcerpt');
    if (typeof rawExcerpt !== 'string' || rawExcerpt.length === 0) {
      throw new FindingReviewPublicationSourceBindingError(index, 'requires rawExcerpt');
    }
    try {
      bindReviewerReportExcerpt(reportContent, rawExcerpt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new FindingReviewPublicationSourceBindingError(index, detail, error);
    }
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

export function createPendingFindingReviewNormalization(input: {
  readonly identity: FindingReviewPublicationIdentity;
  readonly workflowName: string;
  readonly reportContent: string;
  readonly reviewerExecutionIdentity: ReviewerExecutionIdentity;
}): PendingFindingReviewNormalization {
  const pending: PendingFindingReviewNormalization = {
    ...input.identity,
    workflowName: input.workflowName,
    publicationId: computeFindingReviewPublicationId(input.identity),
    protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
    reportContent: input.reportContent,
    reportDigest: sha256(Buffer.from(input.reportContent, 'utf8')),
    reviewerExecutionIdentity: parseReviewerExecutionIdentity(
      input.reviewerExecutionIdentity,
    ),
  };
  assertPendingFindingReviewNormalization(pending);
  return deepFreeze(pending);
}

export function loadPendingFindingReviewNormalization(
  reportDir: string,
  identity: FindingReviewPublicationIdentity,
  expectedWorkflowName: string,
): PendingFindingReviewNormalization | undefined {
  const publicationId = computeFindingReviewPublicationId(identity);
  const path = pendingNormalizationRecordPath(reportDir, publicationId);
  ensurePrivateDirectory(dirname(path));
  const snapshot = readPrivateFileState(path);
  if (!snapshot.state.exists) {
    return rebindInheritedPendingFindingReviewNormalization(
      reportDir,
      identity,
      expectedWorkflowName,
    );
  }
  if (!('content' in snapshot)) {
    throw new Error(`Pending finding review normalization content is missing: ${path}`);
  }
  const pending = parseStoredPendingNormalization(snapshot.content, publicationId);
  if (pending.workflowName !== expectedWorkflowName) {
    throw new Error(
      `Pending finding review normalization workflow mismatch for "${publicationId}"`,
    );
  }
  return pending;
}

export function persistPendingFindingReviewNormalization(
  reportDir: string,
  pending: PendingFindingReviewNormalization,
): PendingFindingReviewNormalization {
  assertPendingFindingReviewNormalization(pending);
  const path = pendingNormalizationRecordPath(reportDir, pending.publicationId);
  ensurePrivateDirectory(dirname(path));
  return runPrivateFileExclusive(`${path}.lock`, () => {
    const snapshot = readPrivateFileState(path);
    if (snapshot.state.exists) {
      if (!('content' in snapshot)) {
        throw new Error(`Pending finding review normalization content is missing: ${path}`);
      }
      const existing = parseStoredPendingNormalization(
        snapshot.content,
        pending.publicationId,
      );
      if (
        existing.reportDigest !== pending.reportDigest
        || existing.workflowName !== pending.workflowName
        || !samePublicationProtocol(existing.protocol, pending.protocol)
        || JSON.stringify(existing.reviewerExecutionIdentity)
          !== JSON.stringify(pending.reviewerExecutionIdentity)
      ) {
        throw new Error(
          `Pending finding review normalization conflict for "${pending.publicationId}"`,
        );
      }
      return existing;
    }
    writeNewPrivateFileWithMode(path, JSON.stringify(pending), PRIVATE_FILE_MODE);
    return pending;
  });
}

export function loadFindingReviewPublication(
  reportDir: string,
  identity: FindingReviewPublicationIdentity,
  expectedProtocol?: FindingReviewPublicationProtocol,
): FindingReviewPublicationPreparation | undefined {
  const publicationId = computeFindingReviewPublicationId(identity);
  const path = publicationRecordPath(reportDir, publicationId);
  ensurePrivateDirectory(dirname(path));
  const snapshot = readPrivateFileState(path);
  if (!snapshot.state.exists) {
    return rebindInheritedFindingReviewPublication(
      reportDir,
      identity,
      expectedProtocol,
    );
  }
  if (!('content' in snapshot)) {
    throw new Error(`Finding review publication content is missing: ${path}`);
  }
  const preparation = parseStoredPreparation(snapshot.content, publicationId);
  if (
    expectedProtocol !== undefined
    && !samePublicationProtocol(preparation.publication.protocol, expectedProtocol)
  ) {
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
  if (preparation.reviewerExecutionIdentity === undefined) {
    throw new Error(
      `Finding review publication "${publication.publicationId}" requires reviewerExecutionIdentity`,
    );
  }
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
        || JSON.stringify(existing.reviewerExecutionIdentity ?? null)
          !== JSON.stringify(preparation.reviewerExecutionIdentity ?? null)
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
