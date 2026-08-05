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
  RAW_FINDING_LIMITS,
} from './raw-finding-limits.js';
import type { ReviewerRelationClarification } from './relation-coherence.js';
import { isProviderType, type ProviderType } from '../../../shared/types/provider.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { IntakeContractMissingRequirement } from '../../models/finding-types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

const PRIVATE_FILE_MODE = 0o600;
const STORED_PUBLICATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;

const LEGACY_STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'structured',
  format: 'structured-output',
  protocolRevision: 1,
} as const);

const LEGACY_PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'freeform',
  format: 'normalized-plain-text',
  protocolRevision: 1,
} as const);

export const STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'structured',
  format: 'structured-output',
  protocolRevision: 2,
} as const);

export const PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL = Object.freeze({
  generationMode: 'freeform',
  format: 'normalized-plain-text',
  protocolRevision: 2,
} as const);

export type FindingReviewPublicationProtocol =
  | typeof LEGACY_STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL
  | typeof LEGACY_PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL
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
  readonly presentationContext: FindingReviewPresentationContext;
  readonly reviewerOutputOverflow?: FindingReviewPublicationOverflow;
}

export interface RestatementRequestV1 {
  readonly restatementRequestId: string;
  readonly anomalyId: string;
  readonly reviewer: string;
  readonly presentationOrdinal: number;
  readonly reviewScopeSnapshotId: string;
  readonly sourceExcerptDigest: string;
  readonly claimedExcerpt: string;
  readonly targetPaths: readonly string[];
  readonly missingRequirements: readonly IntakeContractMissingRequirement[];
  readonly expectedRelation: 'new';
  readonly expectedTargetFindingId: null;
  readonly expectedTargetPreconditionClass: 'absent';
}

export interface RestatementRequestBinding {
  readonly request: RestatementRequestV1;
  readonly publicationId: string;
  readonly reportDigest: string;
}

export interface FindingReviewPresentationContextV1 {
  readonly revision: 1;
  readonly restatementRequests: readonly [];
  readonly presentedReviewerAnomalyIds: readonly [];
}

export interface FindingReviewPresentationContextV2 {
  readonly revision: 2;
  readonly reviewScopeSnapshotId: string;
  readonly restatementRequests: readonly RestatementRequestV1[];
  readonly presentedReviewerAnomalyIds: readonly string[];
  readonly contextDigest: string;
}

export type FindingReviewPresentationContext =
  | FindingReviewPresentationContextV1
  | FindingReviewPresentationContextV2;

export interface FindingReviewPublicationOverflow {
  readonly kind: 'reviewer-output-overflow';
  readonly emittedAtomizedRawFindingCount: number;
  readonly admittedAtomizedRawFindingCount: number;
  readonly overflowAtomizedRawFindingCount: number;
  readonly reason: string;
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
  readonly protocol:
    | typeof LEGACY_PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL
    | typeof PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  readonly reportContent: string;
  readonly reportDigest: string;
  readonly reviewerExecutionIdentity: ReviewerExecutionIdentity;
  readonly presentationContext: FindingReviewPresentationContext;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

function compareRestatementRequests(
  left: RestatementRequestV1,
  right: RestatementRequestV1,
): number {
  return left.presentationOrdinal - right.presentationOrdinal
    || compareBinaryStrings(left.anomalyId, right.anomalyId)
    || compareBinaryStrings(left.restatementRequestId, right.restatementRequestId);
}

function restatementRequestIdentity(request: Omit<RestatementRequestV1, 'restatementRequestId'>): string {
  return sha256(JSON.stringify([
    'restatement-request-v1',
    request.anomalyId,
    request.reviewer,
    request.presentationOrdinal,
    request.reviewScopeSnapshotId,
    request.sourceExcerptDigest,
    request.claimedExcerpt,
    request.targetPaths,
    request.missingRequirements,
    request.expectedRelation,
    request.expectedTargetFindingId,
    request.expectedTargetPreconditionClass,
  ]));
}

export function computeRestatementRequestId(
  request: Omit<RestatementRequestV1, 'restatementRequestId'>,
): string {
  return restatementRequestIdentity(request);
}

export function computeFindingReviewPresentationContextDigest(input: {
  reviewScopeSnapshotId: string;
  restatementRequests: readonly RestatementRequestV1[];
  presentedReviewerAnomalyIds: readonly string[];
}): string {
  const restatementRequestDigestValues = input.restatementRequests.map((request) => [
    request.restatementRequestId,
    request.anomalyId,
    request.reviewer,
    request.presentationOrdinal,
    request.reviewScopeSnapshotId,
    request.sourceExcerptDigest,
    request.claimedExcerpt,
    request.targetPaths,
    request.missingRequirements,
    request.expectedRelation,
    request.expectedTargetFindingId,
    request.expectedTargetPreconditionClass,
  ]);
  return sha256(JSON.stringify([
    'finding-review-presentation-context-v2',
    2,
    input.reviewScopeSnapshotId,
    restatementRequestDigestValues,
    input.presentedReviewerAnomalyIds,
  ]));
}

export function createFindingReviewPresentationContextV2(input: {
  reviewScopeSnapshotId: string;
  restatementRequests?: readonly RestatementRequestV1[];
}): FindingReviewPresentationContextV2 {
  const requests = [...(input.restatementRequests ?? [])].sort(compareRestatementRequests);
  const anomalyIds = sortedUnique(requests.map((request) => request.anomalyId));
  const context: FindingReviewPresentationContextV2 = {
    revision: 2,
    reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    restatementRequests: requests,
    presentedReviewerAnomalyIds: anomalyIds,
    contextDigest: computeFindingReviewPresentationContextDigest({
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      restatementRequests: requests,
      presentedReviewerAnomalyIds: anomalyIds,
    }),
  };
  assertFindingReviewPresentationContext(context);
  return deepFreeze(context);
}

export function collectRestatementRequests(
  publications: readonly Pick<CanonicalFindingReviewPublication, 'presentationContext'>[],
): RestatementRequestV1[] {
  const byId = new Map<string, RestatementRequestV1>();
  for (const publication of publications) {
    if (publication.presentationContext?.revision !== 2) {
      continue;
    }
    for (const request of publication.presentationContext.restatementRequests) {
      const existing = byId.get(request.restatementRequestId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(request)) {
        throw new Error(`Restatement request "${request.restatementRequestId}" has conflicting content`);
      }
      byId.set(request.restatementRequestId, request);
    }
  }
  return [...byId.values()].sort((left, right) => (
    compareBinaryStrings(left.reviewer, right.reviewer)
    || left.presentationOrdinal - right.presentationOrdinal
    || compareBinaryStrings(left.anomalyId, right.anomalyId)
    || compareBinaryStrings(left.restatementRequestId, right.restatementRequestId)
  ));
}

export function collectRestatementRequestBindings(
  publications: readonly Pick<CanonicalFindingReviewPublication, 'presentationContext' | 'publicationId' | 'reportDigest'>[],
): RestatementRequestBinding[] {
  const bindingsById = new Map<string, RestatementRequestBinding>();
  for (const publication of publications) {
    if (publication.presentationContext?.revision !== 2) {
      continue;
    }
    for (const request of publication.presentationContext.restatementRequests) {
      const binding: RestatementRequestBinding = {
        request,
        publicationId: publication.publicationId,
        reportDigest: publication.reportDigest,
      };
      const existing = bindingsById.get(request.restatementRequestId);
      if (existing !== undefined) {
        if (
          JSON.stringify(existing.request) !== JSON.stringify(request)
          || existing.publicationId !== publication.publicationId
          || existing.reportDigest !== publication.reportDigest
        ) {
          throw new Error(`Restatement request "${request.restatementRequestId}" has conflicting binding`);
        }
        continue;
      }
      bindingsById.set(request.restatementRequestId, binding);
    }
  }
  return [...bindingsById.values()].sort((left, right) => (
    compareBinaryStrings(left.request.reviewer, right.request.reviewer)
    || left.request.presentationOrdinal - right.request.presentationOrdinal
    || compareBinaryStrings(left.request.anomalyId, right.request.anomalyId)
    || compareBinaryStrings(left.request.restatementRequestId, right.request.restatementRequestId)
  ));
}

export function assertFindingReviewPresentationContext(
  context: FindingReviewPresentationContext,
): void {
  if (context.revision === 1) {
    if (context.restatementRequests.length !== 0 || context.presentedReviewerAnomalyIds.length !== 0) {
      throw new Error('Legacy finding review presentation context must be empty');
    }
    return;
  }
  if (context.reviewScopeSnapshotId.length === 0 || context.restatementRequests.length > 64) {
    throw new Error('Finding review presentation context has an invalid scope or request count');
  }
  const requestKeys = context.restatementRequests.map((request) => {
    if (
      request.restatementRequestId !== restatementRequestIdentity(request)
      || request.expectedRelation !== 'new'
      || request.expectedTargetFindingId !== null
      || request.expectedTargetPreconditionClass !== 'absent'
      || request.reviewScopeSnapshotId !== context.reviewScopeSnapshotId
      || request.reviewer.length === 0
      || request.anomalyId.length === 0
      || request.sourceExcerptDigest.length === 0
      || typeof request.claimedExcerpt !== 'string'
      || !Array.isArray(request.targetPaths)
      || !request.targetPaths.every((path) => typeof path === 'string' && path.length > 0)
      || JSON.stringify(sortedUnique(request.targetPaths)) !== JSON.stringify(request.targetPaths)
      || !Array.isArray(request.missingRequirements)
      || !request.missingRequirements.every((requirement) => (
        requirement === 'relation'
        || requirement === 'target'
        || requirement === 'familyTag'
        || requirement === 'severity'
        || requirement === 'title'
        || requirement === 'description'
        || requirement === 'claimEvidence'
      ))
      || JSON.stringify(sortedUnique(request.missingRequirements))
        !== JSON.stringify(request.missingRequirements)
      || !Number.isSafeInteger(request.presentationOrdinal)
      || request.presentationOrdinal < 1
    ) {
      throw new Error('Finding review presentation context contains an invalid restatement request');
    }
    return `${String(request.presentationOrdinal)}\0${request.anomalyId}\0${request.restatementRequestId}`;
  });
  if (new Set(requestKeys).size !== requestKeys.length) {
    throw new Error('Finding review presentation context contains duplicate restatement requests');
  }
  const sortedRequests = [...context.restatementRequests].sort(compareRestatementRequests);
  if (JSON.stringify(sortedRequests) !== JSON.stringify(context.restatementRequests)) {
    throw new Error('Finding review presentation restatement requests are not binary sorted');
  }
  const expectedAnomalyIds = sortedUnique(context.restatementRequests.map((request) => request.anomalyId));
  if (
    JSON.stringify(expectedAnomalyIds) !== JSON.stringify(context.presentedReviewerAnomalyIds)
    || JSON.stringify(context.presentedReviewerAnomalyIds)
      !== JSON.stringify(sortedUnique(context.presentedReviewerAnomalyIds))
    || context.contextDigest !== computeFindingReviewPresentationContextDigest(context)
  ) {
    throw new Error('Finding review presentation context digest or anomaly projection is invalid');
  }
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
    reviewerOutputOverflow: preparation.publication.reviewerOutputOverflow ?? null,
    presentationContext: preparation.publication.presentationContext,
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
      && publication.protocol.protocolRevision === 2
      && (
        publication.presentationContext.revision === 1
        || publication.presentationContext.restatementRequests.length === 0
      )
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
      presentationContext: first.publication.presentationContext,
      ...(first.publication.reviewerOutputOverflow === undefined
        ? {}
        : { reviewerOutputOverflow: first.publication.reviewerOutputOverflow }),
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
    presentationContext: pending.presentationContext,
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
    .filter((pending) => samePublicationIdentityExceptScope(pending, identity))
    .filter((pending) => pending.protocol.protocolRevision === 2)
    .filter((pending) => (
      pending.presentationContext.revision === 1
      || pending.presentationContext.restatementRequests.length === 0
    ));
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
      presentationContext: first.presentationContext,
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
  const legacyStructured = LEGACY_STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  if (
    record.generationMode === legacyStructured.generationMode
    && record.format === legacyStructured.format
    && record.protocolRevision === legacyStructured.protocolRevision
  ) {
    return legacyStructured;
  }
  const legacyPlainTextNormalized = LEGACY_PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
  if (
    record.generationMode === legacyPlainTextNormalized.generationMode
    && record.format === legacyPlainTextNormalized.format
    && record.protocolRevision === legacyPlainTextNormalized.protocolRevision
  ) {
    return legacyPlainTextNormalized;
  }
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

function assertProtocolPresentationCompatibility(
  protocol: FindingReviewPublicationProtocol,
  presentationContext: FindingReviewPresentationContext,
): void {
  if (protocol.protocolRevision === 1 && presentationContext.revision !== 1) {
    throw new Error('Legacy finding review publication protocol cannot carry V2 presentation context');
  }
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

function parseStoredReviewerOutputOverflow(
  value: unknown,
): FindingReviewPublicationOverflow | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Finding review publication reviewerOutputOverflow is not an object');
  }
  const record = value as Record<string, unknown>;
  const countFields = [
    'emittedAtomizedRawFindingCount',
    'admittedAtomizedRawFindingCount',
    'overflowAtomizedRawFindingCount',
  ] as const;
  if (
    record.kind !== 'reviewer-output-overflow'
    || typeof record.reason !== 'string'
    || record.reason.length === 0
    || !countFields.every((field) => (
      Number.isSafeInteger(record[field]) && Number(record[field]) >= 0
    ))
  ) {
    throw new Error('Finding review publication reviewerOutputOverflow is invalid');
  }
  return structuredClone(value) as FindingReviewPublicationOverflow;
}

function parseStoredPresentationContext(
  value: unknown,
): FindingReviewPresentationContext {
  if (value === undefined) {
    return { revision: 1, restatementRequests: [], presentedReviewerAnomalyIds: [] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Finding review publication presentationContext is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.revision === 1) {
    const legacy: FindingReviewPresentationContextV1 = {
      revision: 1,
      restatementRequests: [],
      presentedReviewerAnomalyIds: [],
    };
    assertFindingReviewPresentationContext(legacy);
    return legacy;
  }
  if (
    record.revision !== 2
    || typeof record.reviewScopeSnapshotId !== 'string'
    || !Array.isArray(record.restatementRequests)
    || !Array.isArray(record.presentedReviewerAnomalyIds)
    || !record.presentedReviewerAnomalyIds.every((id) => typeof id === 'string')
    || typeof record.contextDigest !== 'string'
  ) {
    throw new Error('Finding review publication presentationContext is invalid');
  }
  const restatementRequests = record.restatementRequests.map((value): RestatementRequestV1 => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Finding review publication restatement request is invalid');
    }
    const request = value as Record<string, unknown>;
    if (
      typeof request.restatementRequestId !== 'string'
      || typeof request.anomalyId !== 'string'
      || typeof request.reviewer !== 'string'
      || !Number.isSafeInteger(request.presentationOrdinal)
      || typeof request.reviewScopeSnapshotId !== 'string'
      || typeof request.sourceExcerptDigest !== 'string'
      || typeof request.claimedExcerpt !== 'string'
      || !Array.isArray(request.targetPaths)
      || !request.targetPaths.every((path) => typeof path === 'string')
      || !Array.isArray(request.missingRequirements)
      || !request.missingRequirements.every((requirement) => typeof requirement === 'string')
      || request.expectedRelation !== 'new'
      || request.expectedTargetFindingId !== null
      || request.expectedTargetPreconditionClass !== 'absent'
    ) {
      throw new Error('Finding review publication restatement request is invalid');
    }
    return {
      anomalyId: request.anomalyId,
      reviewer: request.reviewer,
      presentationOrdinal: Number(request.presentationOrdinal),
      reviewScopeSnapshotId: request.reviewScopeSnapshotId,
      sourceExcerptDigest: request.sourceExcerptDigest,
      claimedExcerpt: request.claimedExcerpt,
      targetPaths: sortedUnique(request.targetPaths),
      missingRequirements: sortedUnique(request.missingRequirements) as IntakeContractMissingRequirement[],
      expectedRelation: 'new',
      expectedTargetFindingId: null,
      expectedTargetPreconditionClass: 'absent',
      restatementRequestId: request.restatementRequestId,
    };
  });
  const context: FindingReviewPresentationContextV2 = {
    revision: 2,
    reviewScopeSnapshotId: record.reviewScopeSnapshotId,
    restatementRequests,
    presentedReviewerAnomalyIds: record.presentedReviewerAnomalyIds,
    contextDigest: record.contextDigest,
  };
  assertFindingReviewPresentationContext(context);
  return deepFreeze(context);
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
    presentationContext: parseStoredPresentationContext(publicationRecord.presentationContext),
    ...(publicationRecord.reviewerOutputOverflow === undefined
      ? {}
      : {
          reviewerOutputOverflow: parseStoredReviewerOutputOverflow(
            publicationRecord.reviewerOutputOverflow,
          )!,
        }),
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
  ) && pending.protocol.protocolRevision !== 1) {
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
  assertProtocolPresentationCompatibility(pending.protocol, pending.presentationContext);
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
    presentationContext: parseStoredPresentationContext(record.presentationContext),
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

function atomizedRawFindingCount(rawFindings: readonly unknown[]): number {
  return rawFindings.reduce<number>(
    (total, item) => total + Math.max(
      1,
      extractLenientRawFields(item).targetFindingIds?.length ?? 0,
    ),
    0,
  );
}

function boundPartialAtomizedRawFinding(
  item: unknown,
  admittedTargetFindingIds: readonly string[],
): unknown {
  const projected = projectReviewerRawStructuredOutputWithEnvelope({
    rawFindings: [item],
  }).structuredOutput.rawFindings;
  if (!Array.isArray(projected) || projected.length !== 1) {
    throw new Error('Finding review publication could not project overflow boundary item');
  }
  const bounded = projected[0];
  if (typeof bounded !== 'object' || bounded === null || Array.isArray(bounded)) {
    throw new Error('Finding review publication overflow boundary item is invalid');
  }
  const candidate = Reflect.get(bounded, 'candidate');
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('Finding review publication overflow boundary candidate is invalid');
  }
  return {
    ...bounded,
    candidate: {
      ...candidate,
      targetFindingIds: [...admittedTargetFindingIds],
    },
  };
}

function boundPublicationRawFindings(input: {
  rawFindings: readonly unknown[];
  sourceEnvelope: ReviewerRawResourceEnvelope;
}): {
  rawFindings: readonly unknown[];
  resourceEnvelope: ReviewerRawResourceEnvelope;
  reviewerOutputOverflow?: FindingReviewPublicationOverflow;
} {
  if (
    input.sourceEnvelope.itemCount !== input.rawFindings.length
    || input.sourceEnvelope.itemSourceBytes.length !== input.rawFindings.length
  ) {
    throw new Error('Finding review publication resource envelope does not match rawFindings');
  }
  if (
    input.sourceEnvelope.jsonBytes
    > RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes
  ) {
    throw new Error(
      `Finding review publication exceeded limits: reviewer rawFindings JSON is ${input.sourceEnvelope.jsonBytes} bytes, exceeding the per-reviewer limit of ${RAW_FINDING_LIMITS.maxReviewerRawFindingsJsonBytes} bytes`,
    );
  }

  const emittedCount = atomizedRawFindingCount(input.rawFindings);
  if (emittedCount <= RAW_FINDING_LIMITS.maxRawFindingsPerReviewer) {
    return {
      rawFindings: input.rawFindings,
      resourceEnvelope: input.sourceEnvelope,
    };
  }

  const bounded: unknown[] = [];
  let admittedCount = 0;
  for (const item of input.rawFindings) {
    const fields = extractLenientRawFields(item);
    const itemCount = Math.max(1, fields.targetFindingIds?.length ?? 0);
    const remaining = RAW_FINDING_LIMITS.maxRawFindingsPerReviewer - admittedCount;
    if (remaining === 0) {
      break;
    }
    if (itemCount <= remaining) {
      bounded.push(item);
      admittedCount += itemCount;
      continue;
    }
    if (fields.targetFindingIds === undefined) {
      throw new Error('Finding review publication could not settle atomized overflow boundary');
    }
    bounded.push(boundPartialAtomizedRawFinding(
      item,
      fields.targetFindingIds.slice(0, remaining),
    ));
    admittedCount += remaining;
  }

  const overflowCount = emittedCount - admittedCount;
  const reason = `reviewer emitted ${emittedCount} atomized raw findings; admitted ${admittedCount} and recorded ${overflowCount} as reviewer-output-overflow`;
  return {
    rawFindings: bounded,
    resourceEnvelope: projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: bounded,
    }).resourceEnvelope,
    reviewerOutputOverflow: {
      kind: 'reviewer-output-overflow',
      emittedAtomizedRawFindingCount: emittedCount,
      admittedAtomizedRawFindingCount: admittedCount,
      overflowAtomizedRawFindingCount: overflowCount,
      reason,
    },
  };
}

function assertReviewerOutputOverflow(
  publication: CanonicalFindingReviewPublication,
): void {
  const overflow = publication.reviewerOutputOverflow;
  if (overflow === undefined) {
    return;
  }
  const admittedCount = atomizedRawFindingCount(publication.rawFindings);
  const counts = [
    overflow.emittedAtomizedRawFindingCount,
    overflow.admittedAtomizedRawFindingCount,
    overflow.overflowAtomizedRawFindingCount,
  ];
  if (
    overflow.kind !== 'reviewer-output-overflow'
    || overflow.reason.length === 0
    || !counts.every(Number.isSafeInteger)
    || admittedCount !== overflow.admittedAtomizedRawFindingCount
    || admittedCount !== RAW_FINDING_LIMITS.maxRawFindingsPerReviewer
    || overflow.emittedAtomizedRawFindingCount
      !== admittedCount + overflow.overflowAtomizedRawFindingCount
    || overflow.overflowAtomizedRawFindingCount <= 0
  ) {
    throw new Error('Finding review publication reviewerOutputOverflow is inconsistent');
  }
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
  assertProtocolPresentationCompatibility(publication.protocol, publication.presentationContext);
  const expectedId = computeFindingReviewPublicationId(publication);
  if (publication.publicationId !== expectedId) {
    throw new Error(`Finding review publication identity mismatch for "${publication.publicationId}"`);
  }
  const reportDigest = sha256(Buffer.from(publication.reportContent, 'utf8'));
  if (publication.reportDigest !== reportDigest) {
    throw new Error(`Finding review publication digest mismatch for "${publication.publicationId}"`);
  }
  assertPublicationRawFindings(publication.reportContent, publication.rawFindings);
  assertReviewerOutputOverflow(publication);
  assertFindingReviewPresentationContext(publication.presentationContext);
  if (
    publication.presentationContext.revision === 2
    && publication.presentationContext.restatementRequests.some(
      (request) => request.reviewer !== publication.reviewerStepName,
    )
  ) {
    throw new Error('Finding review presentation request reviewer does not match publication reviewer');
  }
}

export function createFindingReviewPublication(input: {
  readonly identity: FindingReviewPublicationIdentity;
  readonly protocol: FindingReviewPublicationProtocol;
  readonly reportContent: string;
  readonly rawFindings: readonly unknown[];
  readonly presentationContext?: FindingReviewPresentationContext;
  readonly reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
  readonly reviewerOutputOverflow?: FindingReviewPublicationOverflow;
}): CanonicalFindingReviewPublication {
  const sourceEnvelope = input.reviewerRawResourceEnvelope
    ?? projectReviewerRawStructuredOutputWithEnvelope({
      rawFindings: input.rawFindings,
    }).resourceEnvelope;
  const bounded = boundPublicationRawFindings({
    rawFindings: input.rawFindings,
    sourceEnvelope,
  });
  if (
    bounded.reviewerOutputOverflow !== undefined
    && input.reviewerOutputOverflow !== undefined
  ) {
    throw new Error('Finding review publication received duplicate overflow metadata');
  }
  const reviewerOutputOverflow = bounded.reviewerOutputOverflow
    ?? input.reviewerOutputOverflow;
  const publication: CanonicalFindingReviewPublication = {
    ...input.identity,
    publicationId: computeFindingReviewPublicationId(input.identity),
    protocol: input.protocol,
    reportContent: input.reportContent,
    reportDigest: sha256(Buffer.from(input.reportContent, 'utf8')),
    rawFindings: structuredClone(bounded.rawFindings),
    presentationContext: input.presentationContext
      ?? { revision: 1, restatementRequests: [], presentedReviewerAnomalyIds: [] },
    ...(reviewerOutputOverflow === undefined
      ? {}
      : { reviewerOutputOverflow }),
  };
  assertPublicationRawFindings(
    publication.reportContent,
    publication.rawFindings,
    bounded.resourceEnvelope,
  );
  assertCanonicalFindingReviewPublication(publication);
  return freezeCanonicalFindingReviewPublication(publication);
}

export function createPendingFindingReviewNormalization(input: {
  readonly identity: FindingReviewPublicationIdentity;
  readonly workflowName: string;
  readonly reportContent: string;
  readonly reviewerExecutionIdentity: ReviewerExecutionIdentity;
  readonly presentationContext?: FindingReviewPresentationContext;
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
    presentationContext: input.presentationContext
      ?? { revision: 1, restatementRequests: [], presentedReviewerAnomalyIds: [] },
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
        || JSON.stringify(existing.presentationContext)
          !== JSON.stringify(pending.presentationContext)
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
    && preparation.publication.protocol.protocolRevision !== 1
    && !samePublicationProtocol(preparation.publication.protocol, expectedProtocol)
  ) {
    throw new Error(
      `Finding review publication protocol mismatch for "${publicationId}"`,
    );
  }
  return preparation;
}

/** 保存済みの canonical publication だけを監査・提示計上へ利用する。 */
export function listFindingReviewPublications(
  reportDir: string,
): CanonicalFindingReviewPublication[] {
  const directory = resolve(
    reportDir,
    REPORT_INTERNAL_NAMESPACE,
    FINDING_REVIEW_PUBLICATIONS_INTERNAL_DIRECTORY,
  );
  return readStoredRecordContents(directory)
    .map(({ publicationId, content }) => parseStoredPreparation(content, publicationId).publication)
    .sort((left, right) => (
      left.stepIteration - right.stepIteration
      || compareBinaryStrings(left.publicationId, right.publicationId)
    ));
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
        || JSON.stringify(existing.publication.presentationContext)
          !== JSON.stringify(publication.presentationContext)
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
