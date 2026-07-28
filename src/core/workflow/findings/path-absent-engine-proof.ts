import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import {
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  inspectSafePathSegments,
  isPathInside,
  type BoundaryViolation,
  type SafePathSegmentInspection,
} from '../../../shared/utils/pathBoundary.js';
import type {
  EngineProofRecord,
  EngineProofSubject,
} from './types.js';
import type {
  EngineProofSubjectVerification,
  EngineProofVerificationContext,
  EngineProofVerifier,
} from './evidence-domain.js';

const VERIFIER_ID = 'takt.path-absent';
const VERIFIER_VERSION = '2';
type InspectedPathKind = 'symbolic_link' | 'directory' | 'regular_file' | 'other';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function pathStateDigest(input: {
  subjectPath: string;
  root: {
    lexicalKind: InspectedPathKind;
    realPath: string;
  };
  segments: Array<{
    path: string;
    kind: InspectedPathKind | 'missing';
    realPath?: string;
  }>;
}): string {
  return digest({
    domain: 'finding-path-absence-dependency',
    version: 2,
    ...input,
  });
}

function pathAbsenceResultDigest(
  subject: Extract<EngineProofSubject, { kind: 'path_absent' }>,
  predicateSatisfied: boolean,
): string {
  return digest({
    domain: 'finding-path-absence-result',
    version: 1,
    subject,
    predicateSatisfied,
  });
}

class PathAbsenceBoundaryError extends Error {
  constructor(
    readonly violation: BoundaryViolation,
    readonly segmentPath: string,
  ) {
    super(`path_absent boundary violation (${violation}): ${segmentPath}`);
  }
}

function buildBoundaryError(
  violation: BoundaryViolation,
  segmentPath: string,
): PathAbsenceBoundaryError {
  return new PathAbsenceBoundaryError(violation, segmentPath);
}

function pathKind(stats: Stats): InspectedPathKind {
  if (stats.isSymbolicLink()) return 'symbolic_link';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'regular_file';
  return 'other';
}

function validateProjectRelativePath(path: string): string | undefined {
  if (path.includes('\0') || isAbsolute(path)) {
    return 'must be project-relative';
  }
  if (
    path === '.'
    || normalize(path) !== path
    || path.split(sep).some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return 'must be a normalized project-relative path without traversal segments';
  }
  return undefined;
}

function dependencyForInspection(
  subjectPath: string,
  inspection: SafePathSegmentInspection,
): string {
  const rootStats = lstatSync(inspection.resolvedRoot);
  const realRoot = realpathSync(inspection.resolvedRoot);
  if (!lstatSync(realRoot).isDirectory()) {
    throw new Error(`path_absent project root "${inspection.resolvedRoot}" is not a directory`);
  }
  const segments: Array<{
    path: string;
    kind: InspectedPathKind | 'missing';
    realPath?: string;
  }> = inspection.segments.map((segment) => {
    const projectRelativePath = relative(inspection.resolvedRoot, segment.path);
    if (segment.stats === null) {
      return {
        path: projectRelativePath,
        kind: 'missing',
      };
    }
    const realPath = realpathSync(segment.path);
    if (!isPathInside(realRoot, realPath)) {
      throw buildBoundaryError('outside', segment.path);
    }
    return {
      path: projectRelativePath,
      kind: pathKind(segment.stats),
      realPath,
    };
  });
  return pathStateDigest({
    subjectPath,
    root: {
      lexicalKind: pathKind(rootStats),
      realPath: realRoot,
    },
    segments,
  });
}

function inspectPathAbsence(
  subject: Extract<EngineProofSubject, { kind: 'path_absent' }>,
  context: EngineProofVerificationContext,
): EngineProofSubjectVerification {
  const pathViolation = validateProjectRelativePath(subject.path);
  if (pathViolation !== undefined) {
    return {
      outcome: 'invalid-subject',
      reason: `path_absent subject path "${subject.path}" ${pathViolation}`,
    };
  }
  const candidate = resolve(context.cwd, subject.path);
  try {
    const inspection = inspectSafePathSegments(
      context.cwd,
      candidate,
      buildBoundaryError,
      { rejectSamePath: true },
    );
    const terminalSegment = inspection.segments.at(-1);
    if (terminalSegment === undefined) {
      throw new Error(`path_absent subject path "${subject.path}" has no inspectable segment`);
    }
    const predicateSatisfied = terminalSegment.stats === null;
    return {
      outcome: 'evaluated',
      predicateSatisfied,
      dependencyDigests: [dependencyForInspection(subject.path, inspection)],
      resultDigest: pathAbsenceResultDigest(subject, predicateSatisfied),
    };
  } catch (error) {
    if (error instanceof PathAbsenceBoundaryError) {
      return {
        outcome: 'invalid-subject',
        reason: error.message,
      };
    }
    return {
      outcome: 'unverifiable',
      reason: `path_absent subject path "${subject.path}" could not be inspected`,
      error,
    };
  }
}

export const pathAbsentEngineProofVerifier: EngineProofVerifier = Object.freeze({
  verifierId: VERIFIER_ID,
  verifierVersion: VERIFIER_VERSION,
  verify(
    subject: EngineProofSubject,
    context: EngineProofVerificationContext,
  ): EngineProofSubjectVerification {
    if (subject.kind !== 'path_absent') {
      return {
        outcome: 'unsupported',
        reason: `engine proof subject "${subject.kind}" has no registered verifier`,
      };
    }
    return inspectPathAbsence(subject, context);
  },
});

export function issuePathAbsentEngineProof(input: {
  subject: Extract<EngineProofSubject, { kind: 'path_absent' }>;
  context: EngineProofVerificationContext;
  issuedAt: string;
}): EngineProofRecord {
  const verification = pathAbsentEngineProofVerifier.verify(input.subject, input.context);
  if (verification.outcome !== 'evaluated') {
    throw new Error(`Cannot issue path_absent engine proof: ${verification.reason}`);
  }
  if (!verification.predicateSatisfied) {
    throw new Error(
      `Cannot issue path_absent engine proof because "${input.subject.path}" exists`,
    );
  }
  const payload = {
    kind: 'engine_proof' as const,
    verifierId: pathAbsentEngineProofVerifier.verifierId,
    verifierVersion: pathAbsentEngineProofVerifier.verifierVersion,
    workflowName: input.context.workflowName,
    runId: input.context.runId,
    scopeIdentity: input.context.scopeIdentity,
    snapshotId: input.context.snapshotId,
    claimIdentityHash: input.context.claimIdentityHash,
    targetFindingId: input.context.targetFindingId,
    subject: structuredClone(input.subject),
    dependencyDigests: [...verification.dependencyDigests],
    resultDigest: verification.resultDigest,
    issuedAt: input.issuedAt,
  };
  return createEngineProofRecord(payload);
}
