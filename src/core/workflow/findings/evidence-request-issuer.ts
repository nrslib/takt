import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import type {
  EngineProofRecord,
  ClaimEvidenceSubject,
  FindingEvidenceRequest,
  FindingTarget,
  RawFindingEvidence,
} from './types.js';
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
  },
): IssuedEvidenceRequests {
  if (input.target.kind === 'review_scope') {
    return {
      evidence: [],
      engineProofRecords: [],
      coverageGaps: [
        'Review-scope finding has no concrete target for typed evidence verification',
      ],
    };
  }
  const evidence: RawFindingEvidence[] = [];
  const engineProofRecords: EngineProofRecord[] = [];
  const coverageGaps: string[] = [];
  const inventory = context.snapshot.queryInventory;
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));

  const addProof = (record: EngineProofRecord): void => {
    engineProofRecords.push(record);
    evidence.push({ kind: 'engine_proof', proofId: record.proofId });
  };

  for (const request of input.requests) {
    if (request.kind === 'file_quote') {
      if (
        input.target.kind !== 'code'
        || !input.target.paths.includes(request.path)
      ) {
        coverageGaps.push('file_quote request is unrelated to the code target');
        continue;
      }
      evidence.push({
        ...request,
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

  return { evidence, engineProofRecords, coverageGaps };
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
