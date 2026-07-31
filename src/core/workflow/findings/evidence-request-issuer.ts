import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { readRegularFileNoFollow } from '../../../shared/utils/private-file.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import type {
  EngineProofRecord,
  ClaimEvidenceSubject,
  FileQuoteEvidenceRequest,
  FindingEvidenceRequest,
  FindingTarget,
  RawFindingEvidence,
} from './types.js';
import { FINDING_EVIDENCE_ISSUANCE_LIMITS } from '../../models/finding-contract-limits.js';
import { resolveRealPathWithinProject } from './admission-validation.js';
import { materializeSourceQuote } from './source-quote.js';
import type { ReviewScopeProofSnapshot, ReviewScopeQueryInventoryEntry } from './snapshot.js';
import type {
  EngineProofSubjectVerification,
  EngineProofVerifier,
} from './evidence-domain.js';

const TASK_DECLARATION_ID = 'workflow_task';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\0')
    && !/[*?[\]{}]/.test(path)
    && posix.normalize(path) === path
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isCanonicalExplicitRoot(root: string): boolean {
  return root === '.' || isCanonicalRelativePath(root);
}

function pathIsWithinRoot(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

function excludedPathIntersectsRoot(path: string, root: string): boolean {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return pathIsWithinRoot(normalized, root) || pathIsWithinRoot(root, normalized);
}

function isUnsupportedCoverage(
  entry: ReviewScopeQueryInventoryEntry,
): boolean {
  return entry.coverage === 'resource_cap'
    || entry.coverage === 'unsupported_kind'
    || entry.coverage === 'unsupported_path_encoding';
}

function firstPresentPathStateEntry(
  inventory: readonly ReviewScopeQueryInventoryEntry[],
  targetPath: string,
): ReviewScopeQueryInventoryEntry | undefined {
  return inventory.find((entry) => (
    pathIsWithinRoot(entry.path, targetPath)
    && entry.coverage !== 'deleted'
    && entry.coverage !== 'excluded'
    && !isUnsupportedCoverage(entry)
  ));
}

function firstIntersectingCoverageEntry(
  inventory: readonly ReviewScopeQueryInventoryEntry[],
  roots: readonly string[],
  predicate: (entry: ReviewScopeQueryInventoryEntry) => boolean,
): ReviewScopeQueryInventoryEntry | undefined {
  return inventory.find((entry) => (
    predicate(entry)
    && (
      entry.coverage === 'unsupported_path_encoding'
      || roots.some((root) => excludedPathIntersectsRoot(entry.path, root))
    )
  ));
}

function decodeUtf8(entry: ReviewScopeQueryInventoryEntry): string | undefined {
  if (entry.content === undefined || entry.content.includes(0)) {
    return undefined;
  }
  const decoded = entry.content.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(entry.content) ? decoded : undefined;
}

function createClaimProof(input: {
  verifierId: string;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  snapshotId: string;
  claimIdentityHash: string;
  targetFindingId: string | null;
  subject: ClaimEvidenceSubject;
  dependencyDigests: string[];
  result: unknown;
  issuedAt: string;
}): EngineProofRecord {
  return createEngineProofRecord({
    kind: 'engine_proof',
    purpose: 'claim_evidence',
    verifierId: input.verifierId,
    verifierVersion: '1',
    workflowName: input.workflowName,
    runId: input.runId,
    scopeIdentity: input.scopeIdentity,
    snapshotId: input.snapshotId,
    claimIdentityHash: input.claimIdentityHash,
    targetFindingId: input.targetFindingId,
    subject: input.subject,
    dependencyDigests: [...new Set(input.dependencyDigests)].sort(compareBinaryStrings),
    resultDigest: digest(input.result),
    issuedAt: input.issuedAt,
  });
}

export interface EvidenceRequestIssuerContext {
  cwd: string;
  snapshot: ReviewScopeProofSnapshot;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  workflowTask: string;
  issuedAt: string;
  /** Only declarations registered by workflow setup are authoritative. */
  publicDeclarations?: ReadonlyMap<string, string>;
}

export interface IssuedEvidenceRequests {
  evidence: RawFindingEvidence[];
  engineProofRecords: EngineProofRecord[];
  coverageGaps: string[];
  quoteFailureReasons: string[];
  materializedQuoteBytes: number;
}

export interface EvidenceIssuanceByteBudget {
  reviewerRemainingBytes: number;
  stepRemainingBytes: number;
}

type QuoteIssuanceFailure = {
  ok: false;
  kind: 'reviewer_invalid' | 'engine_unverifiable' | 'resource_exhausted';
  reason: string;
};

type QuoteSourceResolution =
  | { ok: true; content: Buffer }
  | QuoteIssuanceFailure;

function contentSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function rereadDigestBoundSource(
  context: EvidenceRequestIssuerContext,
  request: FileQuoteEvidenceRequest,
  contentDigest: string,
): QuoteSourceResolution {
  const resolution = resolveRealPathWithinProject(context.cwd, request.path);
  if (!resolution.ok) {
    return { ok: false, kind: 'engine_unverifiable', reason: resolution.reason };
  }
  if (resolution.stat.size > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes) {
    return {
      ok: false,
      kind: 'resource_exhausted',
      reason: `source file "${request.path}" exceeds the ${FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes}-byte evidence source limit`,
    };
  }
  let content: Buffer;
  try {
    content = readRegularFileNoFollow(resolution.realPath, resolution.stat);
  } catch (error) {
    return {
      ok: false,
      kind: 'engine_unverifiable',
      reason: `source file "${request.path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (contentSha256(content) !== contentDigest) {
    return {
      ok: false,
      kind: 'engine_unverifiable',
      reason: `source file "${request.path}" no longer matches its review scope contentDigest`,
    };
  }
  return { ok: true, content };
}

function resolveDigestBoundQuoteSource(
  context: EvidenceRequestIssuerContext,
  request: FileQuoteEvidenceRequest,
  entry: ReviewScopeQueryInventoryEntry | undefined,
): QuoteSourceResolution {
  if (!isCanonicalRelativePath(request.path)) {
    return {
      ok: false,
      kind: 'reviewer_invalid',
      reason: `file_quote path "${request.path}" is not canonical`,
    };
  }
  if (entry === undefined || entry.kind !== 'file') {
    return {
      ok: false,
      kind: 'engine_unverifiable',
      reason: `file_quote path "${request.path}" is outside complete file coverage`,
    };
  }
  if (entry.contentDigest === undefined || !/^[0-9a-f]{64}$/.test(entry.contentDigest)) {
    return {
      ok: false,
      kind: 'engine_unverifiable',
      reason: `file_quote path "${request.path}" has no canonical contentDigest`,
    };
  }
  if (entry.coverage === 'resource_cap') {
    return {
      ok: false,
      kind: 'resource_exhausted',
      reason: `file_quote path "${request.path}" has coverage "${entry.coverage}"`,
    };
  }
  if (entry.coverage !== 'complete') {
    return {
      ok: false,
      kind: 'engine_unverifiable',
      reason: `file_quote path "${request.path}" has coverage "${entry.coverage}"`,
    };
  }
  if (entry.content !== undefined) {
    if (entry.content.length > FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes) {
      return {
        ok: false,
        kind: 'resource_exhausted',
        reason: `source file "${request.path}" exceeds the ${FINDING_EVIDENCE_ISSUANCE_LIMITS.maxSourceFileBytes}-byte evidence source limit`,
      };
    }
    if (contentSha256(entry.content) !== entry.contentDigest) {
      return {
        ok: false,
        kind: 'engine_unverifiable',
        reason: `retained content for "${request.path}" does not match its contentDigest`,
      };
    }
    return { ok: true, content: Buffer.from(entry.content) };
  }
  return rereadDigestBoundSource(context, request, entry.contentDigest);
}

/**
 * Reviewer requests are observations to perform, never proof records. This issuer uses the
 * already-captured immutable review inventory and the workflow declaration registry.
 */
export function issueFindingEvidenceRequests(
  context: EvidenceRequestIssuerContext,
  input: {
    target: FindingTarget;
    claimIdentityHash: string;
    targetFindingId: string | null;
    requests: readonly FindingEvidenceRequest[];
    quoteByteBudget: EvidenceIssuanceByteBudget;
  },
): IssuedEvidenceRequests {
  if (input.target.kind === 'review_scope') {
    return {
      evidence: [],
      engineProofRecords: [],
      coverageGaps: [
        'Review-scope finding has no concrete target for typed evidence verification',
      ],
      quoteFailureReasons: [],
      materializedQuoteBytes: 0,
    };
  }
  const evidence: RawFindingEvidence[] = [];
  const fileQuoteEvidence: RawFindingEvidence[] = [];
  const engineProofRecords: EngineProofRecord[] = [];
  const coverageGaps: string[] = [];
  const quoteFailureReasons: string[] = [];
  let fileQuoteFailed = false;
  let materializedQuoteBytes = 0;
  let reviewerRemainingBytes = input.quoteByteBudget.reviewerRemainingBytes;
  let stepRemainingBytes = input.quoteByteBudget.stepRemainingBytes;
  const inventory = context.snapshot.queryInventory;
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));

  const addProof = (record: EngineProofRecord): void => {
    engineProofRecords.push(record);
    evidence.push({ kind: 'engine_proof', proofId: record.proofId });
  };
  const addFileQuoteFailure = (failure: QuoteIssuanceFailure): void => {
    coverageGaps.push(failure.reason);
    if (failure.kind === 'reviewer_invalid') {
      quoteFailureReasons.push(failure.reason);
    }
    fileQuoteFailed = true;
  };

  for (const request of input.requests) {
    if (request.kind === 'file_quote') {
      if (
        input.target.kind !== 'code'
        || !input.target.paths.includes(request.path)
      ) {
        addFileQuoteFailure({
          ok: false,
          kind: 'reviewer_invalid',
          reason: 'file_quote request is unrelated to the code target',
        });
        continue;
      }
      const source = resolveDigestBoundQuoteSource(context, request, byPath.get(request.path));
      if (!source.ok) {
        addFileQuoteFailure(source);
        continue;
      }
      const materialized = materializeSourceQuote({
        path: request.path,
        content: source.content,
        startLine: request.startLine,
        endLine: request.endLine,
      });
      if (!materialized.ok) {
        addFileQuoteFailure({
          ok: false,
          kind: materialized.kind === 'invalid'
            ? 'reviewer_invalid'
            : materialized.kind === 'unverifiable'
              ? 'engine_unverifiable'
              : 'resource_exhausted',
          reason: materialized.reason,
        });
        continue;
      }
      if (materialized.quoteBytes > reviewerRemainingBytes) {
        addFileQuoteFailure({
          ok: false,
          kind: 'resource_exhausted',
          reason: `file_quote issuance exceeds the remaining reviewer byte budget (${reviewerRemainingBytes} bytes)`,
        });
        continue;
      }
      if (materialized.quoteBytes > stepRemainingBytes) {
        addFileQuoteFailure({
          ok: false,
          kind: 'resource_exhausted',
          reason: `file_quote issuance exceeds the remaining step byte budget (${stepRemainingBytes} bytes)`,
        });
        continue;
      }
      reviewerRemainingBytes -= materialized.quoteBytes;
      stepRemainingBytes -= materialized.quoteBytes;
      materializedQuoteBytes += materialized.quoteBytes;
      fileQuoteEvidence.push({
        ...request,
        verbatimExcerpt: materialized.verbatimExcerpt,
        snapshotId: context.snapshot.reviewScopeSnapshotId,
      });
      continue;
    }

    if (request.subject.kind === 'repository_manifest') {
      if (input.target.kind !== 'structure') {
        coverageGaps.push('repository_manifest request requires a structure target');
        continue;
      }
      const invalidTarget = input.target.manifestTargets.find(
        (path) => !isCanonicalRelativePath(path),
      );
      if (invalidTarget !== undefined) {
        coverageGaps.push(`manifest target "${invalidTarget}" is not a canonical relative path`);
        continue;
      }
      const invalidRoot = input.target.scope.roots.find(
        (root) => !isCanonicalExplicitRoot(root),
      );
      if (invalidRoot !== undefined) {
        coverageGaps.push(`manifest root "${invalidRoot}" is not a canonical explicit root`);
        continue;
      }
      const manifestCoverageRoots = [
        ...input.target.scope.roots,
        ...input.target.manifestTargets,
      ];
      const excluded = firstIntersectingCoverageEntry(
        inventory,
        manifestCoverageRoots,
        (entry) => entry.coverage === 'excluded',
      );
      if (excluded !== undefined) {
        coverageGaps.push(
          `repository manifest intersects excluded content at "${excluded.path}"`,
        );
        continue;
      }
      const unsupported = firstIntersectingCoverageEntry(
        inventory,
        manifestCoverageRoots,
        isUnsupportedCoverage,
      );
      if (unsupported !== undefined) {
        coverageGaps.push(
          `repository manifest coverage gap at "${unsupported.path}" (${unsupported.coverage})`,
        );
        continue;
      }
      const observed = input.target.manifestTargets.filter((path) => {
        const entry = byPath.get(path);
        return entry !== undefined
          && entry.coverage !== 'deleted'
          && entry.coverage !== 'excluded';
      });
      if (observed.length !== input.target.manifestTargets.length) {
        coverageGaps.push('repository manifest target is missing, excluded, or undecodable');
        continue;
      }
      const dependencyDigests = observed.map((path) => (
        byPath.get(path)?.contentDigest ?? digest({ path, kind: byPath.get(path)?.kind })
      ));
      addProof(createClaimProof({
        verifierId: 'takt.repository-manifest',
        workflowName: context.workflowName,
        runId: context.runId,
        scopeIdentity: context.scopeIdentity,
        snapshotId: context.snapshot.reviewScopeSnapshotId,
        claimIdentityHash: input.claimIdentityHash,
        targetFindingId: input.targetFindingId,
        subject: {
          kind: 'repository_manifest',
          scope: structuredClone(input.target.scope),
          manifestTargets: [...input.target.manifestTargets],
          observedTargets: [...observed],
        },
        dependencyDigests,
        result: { observed },
        issuedAt: context.issuedAt,
      }));
      continue;
    }

    if (request.subject.kind === 'repository_query') {
      if (input.target.kind !== 'absence') {
        coverageGaps.push('repository_query request requires an absence target');
        continue;
      }
      const predicate = input.target.predicate;
      if (predicate.kind === 'path_state') {
        if (!isCanonicalRelativePath(predicate.path)) {
          coverageGaps.push(`path_state path "${predicate.path}" is not canonical`);
          continue;
        }
        const excluded = inventory.some(
          (entry) => entry.coverage === 'excluded'
            && excludedPathIntersectsRoot(entry.path, predicate.path),
        );
        if (excluded) {
          coverageGaps.push(`path_state path "${predicate.path}" intersects excluded content`);
          continue;
        }
        const unsupported = firstIntersectingCoverageEntry(
          inventory,
          [predicate.path],
          isUnsupportedCoverage,
        );
        if (unsupported !== undefined) {
          coverageGaps.push(
            `path_state coverage gap at "${unsupported.path}" (${unsupported.coverage})`,
          );
          continue;
        }
        const existing = firstPresentPathStateEntry(inventory, predicate.path);
        if (existing !== undefined) {
          coverageGaps.push(
            `path_state predicate is not satisfied because "${existing.path}" exists`,
          );
          continue;
        }
        addProof(createClaimProof({
          verifierId: 'takt.repository-query',
          workflowName: context.workflowName,
          runId: context.runId,
          scopeIdentity: context.scopeIdentity,
          snapshotId: context.snapshot.reviewScopeSnapshotId,
          claimIdentityHash: input.claimIdentityHash,
          targetFindingId: input.targetFindingId,
          subject: {
            kind: 'repository_query',
            predicate: structuredClone(predicate),
            result: 'absent',
            coverage: 'complete',
          },
          dependencyDigests: [digest({
            inventoryDigest: context.snapshot.reviewScopeSnapshotId,
            path: predicate.path,
          })],
          result: { result: 'absent' },
          issuedAt: context.issuedAt,
        }));
        continue;
      }

      const invalidRoot = predicate.roots.find((root) => !isCanonicalExplicitRoot(root));
      if (invalidRoot !== undefined) {
        coverageGaps.push(`query root "${invalidRoot}" is not a canonical explicit root`);
        continue;
      }
      const relevant = inventory.filter((entry) => (
        predicate.roots.some((root) => pathIsWithinRoot(entry.path, root))
      ));
      const excluded = firstIntersectingCoverageEntry(
        inventory,
        predicate.roots,
        (entry) => entry.coverage === 'excluded',
      );
      if (excluded !== undefined) {
        coverageGaps.push(
          `query root intersects excluded content at "${excluded.path}"`,
        );
        continue;
      }
      const gap = firstIntersectingCoverageEntry(
        inventory,
        predicate.roots,
        isUnsupportedCoverage,
      );
      if (gap !== undefined) {
        coverageGaps.push(
          `query coverage gap at "${gap.path}" (${gap.coverage})`,
        );
        continue;
      }
      const decoded: Array<{
        entry: ReviewScopeQueryInventoryEntry;
        content: string | undefined;
      }> = relevant
        .filter((entry) => entry.kind === 'file' && entry.coverage === 'complete')
        .map((entry) => ({ entry, content: decodeUtf8(entry) }));
      const undecodable = decoded.find((item) => item.content === undefined);
      if (undecodable !== undefined) {
        coverageGaps.push(`query coverage gap at "${undecodable.entry.path}" (non-UTF-8)`);
        continue;
      }
      const match = decoded.find((item) => item.content!.includes(predicate.literal));
      if (match !== undefined) {
        coverageGaps.push(`exact literal is present in "${match.entry.path}"`);
        continue;
      }
      addProof(createClaimProof({
        verifierId: 'takt.repository-query',
        workflowName: context.workflowName,
        runId: context.runId,
        scopeIdentity: context.scopeIdentity,
        snapshotId: context.snapshot.reviewScopeSnapshotId,
        claimIdentityHash: input.claimIdentityHash,
        targetFindingId: input.targetFindingId,
        subject: {
          kind: 'repository_query',
          predicate: structuredClone(predicate),
          result: 'zero_matches',
          coverage: 'complete',
        },
        dependencyDigests: relevant.flatMap((entry) => (
          entry.contentDigest === undefined ? [] : [entry.contentDigest]
        )),
        result: { result: 'zero_matches', searchedPaths: relevant.map((entry) => entry.path) },
        issuedAt: context.issuedAt,
      }));
      continue;
    }

    const registry = request.subject.source === 'task'
      ? new Map([[TASK_DECLARATION_ID, context.workflowTask]])
      : context.publicDeclarations ?? new Map<string, string>();
    const declaration = registry.get(request.subject.declarationId);
    if (
      declaration === undefined
      || !declaration.includes(request.subject.verbatimExcerpt)
    ) {
      coverageGaps.push(
        `authoritative quote "${request.subject.declarationId}" is not registered or does not contain the excerpt`,
      );
      continue;
    }
    addProof(createClaimProof({
      verifierId: 'takt.authoritative-quote',
      workflowName: context.workflowName,
      runId: context.runId,
      scopeIdentity: context.scopeIdentity,
      snapshotId: context.snapshot.reviewScopeSnapshotId,
      claimIdentityHash: input.claimIdentityHash,
      targetFindingId: input.targetFindingId,
      subject: {
        kind: 'authoritative_quote',
        source: request.subject.source,
        declarationId: request.subject.declarationId,
        verbatimExcerpt: request.subject.verbatimExcerpt,
      },
      dependencyDigests: [digest({ declarationId: request.subject.declarationId, declaration })],
      result: { exists: true },
      issuedAt: context.issuedAt,
    }));
  }

  return {
    evidence: fileQuoteFailed ? evidence : [...fileQuoteEvidence, ...evidence],
    engineProofRecords,
    coverageGaps,
    quoteFailureReasons,
    materializedQuoteBytes,
  };
}

export function createSnapshotEngineProofVerifiers(input: {
  snapshot: ReviewScopeProofSnapshot;
  workflowTask: string;
  publicDeclarations?: ReadonlyMap<string, string>;
}): EngineProofVerifier[] {
  const inventory = input.snapshot.queryInventory;
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
  const unsupported = (kind: string): EngineProofSubjectVerification => ({
    outcome: 'unsupported',
    reason: `engine proof subject "${kind}" is not supported by this verifier`,
  });

  const manifestVerifier: EngineProofVerifier = {
    verifierId: 'takt.repository-manifest',
    verifierVersion: '1',
    verify(subject) {
      if (subject.kind !== 'repository_manifest') {
        return unsupported(subject.kind);
      }
      const manifestCoverageRoots = [
        ...subject.scope.roots,
        ...subject.manifestTargets,
      ];
      const excluded = firstIntersectingCoverageEntry(
        inventory,
        manifestCoverageRoots,
        (entry) => entry.coverage === 'excluded',
      );
      const coverageGap = firstIntersectingCoverageEntry(
        inventory,
        manifestCoverageRoots,
        isUnsupportedCoverage,
      );
      const observed = subject.manifestTargets.filter((path) => {
        const entry = byPath.get(path);
        return entry !== undefined
          && entry.coverage !== 'deleted'
          && entry.coverage !== 'excluded';
      });
      const predicateSatisfied = canonicalJson(observed) === canonicalJson(subject.observedTargets)
        && observed.length === subject.manifestTargets.length
        && excluded === undefined
        && coverageGap === undefined;
      return {
        outcome: 'evaluated',
        predicateSatisfied,
        dependencyDigests: observed.map((path) => (
          byPath.get(path)?.contentDigest ?? digest({ path, kind: byPath.get(path)?.kind })
        )).sort(compareBinaryStrings),
        resultDigest: digest({ observed }),
      };
    },
  };

  const queryVerifier: EngineProofVerifier = {
    verifierId: 'takt.repository-query',
    verifierVersion: '1',
    verify(subject) {
      if (subject.kind !== 'repository_query') {
        return unsupported(subject.kind);
      }
      const predicate = subject.predicate;
      if (predicate.kind === 'path_state') {
        const excluded = inventory.some(
          (entry) => entry.coverage === 'excluded'
            && excludedPathIntersectsRoot(entry.path, predicate.path),
        );
        const coverageGap = firstIntersectingCoverageEntry(
          inventory,
          [predicate.path],
          isUnsupportedCoverage,
        );
        const existing = firstPresentPathStateEntry(inventory, predicate.path);
        const predicateSatisfied = subject.result === 'absent'
          && !excluded
          && coverageGap === undefined
          && existing === undefined;
        return {
          outcome: 'evaluated',
          predicateSatisfied,
          dependencyDigests: [digest({
            inventoryDigest: input.snapshot.reviewScopeSnapshotId,
            path: predicate.path,
          })],
          resultDigest: digest({ result: 'absent' }),
        };
      }
      const relevant = inventory.filter((entry) => (
        predicate.roots.some((root) => pathIsWithinRoot(entry.path, root))
      ));
      const excluded = firstIntersectingCoverageEntry(
        inventory,
        predicate.roots,
        (entry) => entry.coverage === 'excluded',
      );
      const coverageGap = firstIntersectingCoverageEntry(
        inventory,
        predicate.roots,
        isUnsupportedCoverage,
      );
      const coverageComplete = excluded === undefined && coverageGap === undefined;
      const decoded = relevant
        .filter((entry) => entry.kind === 'file' && entry.coverage === 'complete')
        .map((entry) => decodeUtf8(entry));
      const predicateSatisfied = subject.result === 'zero_matches'
        && coverageComplete
        && decoded.every((content) => (
          content !== undefined && !content.includes(predicate.literal)
        ));
      return {
        outcome: 'evaluated',
        predicateSatisfied,
        dependencyDigests: relevant.flatMap((entry) => (
          entry.contentDigest === undefined ? [] : [entry.contentDigest]
        )).sort(compareBinaryStrings),
        resultDigest: digest({
          result: 'zero_matches',
          searchedPaths: relevant.map((entry) => entry.path),
        }),
      };
    },
  };

  const quoteVerifier: EngineProofVerifier = {
    verifierId: 'takt.authoritative-quote',
    verifierVersion: '1',
    verify(subject) {
      if (subject.kind !== 'authoritative_quote') {
        return unsupported(subject.kind);
      }
      const registry = subject.source === 'task'
        ? new Map([[TASK_DECLARATION_ID, input.workflowTask]])
        : input.publicDeclarations ?? new Map<string, string>();
      const declaration = registry.get(subject.declarationId);
      const predicateSatisfied = declaration !== undefined
        && declaration.includes(subject.verbatimExcerpt);
      return {
        outcome: 'evaluated',
        predicateSatisfied,
        dependencyDigests: declaration === undefined
          ? []
          : [digest({ declarationId: subject.declarationId, declaration })],
        resultDigest: digest({ exists: true }),
      };
    },
  };
  return [manifestVerifier, queryVerifier, quoteVerifier];
}
