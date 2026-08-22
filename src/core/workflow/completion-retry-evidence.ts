import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { readRegularFileNoFollow } from '../../shared/utils/private-file.js';
import { isSensitiveProjectFilePath } from '../../shared/utils/sensitive-file-path.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { assertPathSegmentsAreSafe } from '../../shared/utils/pathBoundary.js';
import type { ReviewScopeBaseRange, TaskReviewScope } from './review-scope.js';
import { resolveCompletionRetryPath } from './completion-retry-path.js';
import {
  discoverCompletionRetryReferences,
  type CompletionRetryReferenceEvidence,
  type CompletionRetryReferenceOmissionReason,
} from './completion-retry-reference-discovery.js';

export const COMPLETION_RETRY_EVIDENCE_MAX_PATHS = 64;
const COMPLETION_RETRY_EVIDENCE_MAX_PRIOR_GAP_PATHS = 16;
export const COMPLETION_RETRY_EVIDENCE_MAX_PATH_BYTES = 1024;
export const COMPLETION_RETRY_EVIDENCE_MAX_FILE_BYTES = 32 * 1024;
export const COMPLETION_RETRY_EVIDENCE_MAX_DIFF_BYTES = 256 * 1024;
export const COMPLETION_RETRY_EVIDENCE_MAX_TOTAL_BYTES = 512 * 1024;

type CompletionRetryEvidenceOmissionReason = CompletionRetryReferenceOmissionReason
  | 'binary_file'
  | 'diff_size_limit'
  | 'diff_unavailable'
  | 'file_size_limit'
  | 'file_unavailable'
  | 'path_limit'
  | 'path_size_limit'
  | 'prior_gap_path_unverified'
  | 'sensitive_path'
  | 'total_size_limit'
  | 'unsupported_scope';

export interface CompletionRetryEvidenceFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface CompletionRetryEvidenceOmission {
  readonly reason: CompletionRetryEvidenceOmissionReason;
  readonly count: number;
}

export interface CompletionRetryEvidence {
  readonly status: 'collected' | 'omitted';
  readonly files: readonly CompletionRetryEvidenceFile[];
  readonly diff?: string;
  readonly references: readonly CompletionRetryReferenceEvidence[];
  readonly priorGapPaths: readonly string[];
  readonly omissions: readonly CompletionRetryEvidenceOmission[];
}

function collectDiffText(cwd: string, range: string, paths: readonly string[]): string | undefined {
  const output = execFileSync(
    'git',
    ['diff', '--no-ext-diff', '--no-textconv', range, '--', ...paths],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: COMPLETION_RETRY_EVIDENCE_MAX_DIFF_BYTES,
    },
  );
  const decoded = decodeUtf8(output);
  if (decoded === undefined) {
    throw new Error('Completion retry diff is not UTF-8 text');
  }
  const trimmed = decoded.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function decodeNulPaths(content: Buffer): string[] {
  if (content.length === 0) return [];
  if (content.at(-1) !== 0) throw new Error('git ls-files output is not NUL terminated');
  const decoded = content.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(content)) {
    throw new Error('git ls-files output is not reversibly UTF-8 encoded');
  }
  return decoded.slice(0, -1).split('\0');
}

function trackedPriorGapPaths(cwd: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const output = execFileSync('git', ['ls-files', '--cached', '-z', '--', ...paths], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: COMPLETION_RETRY_EVIDENCE_MAX_DIFF_BYTES,
  });
  return new Set(decodeNulPaths(output));
}

function isCanonicalRepositoryPath(path: string): boolean {
  return path.length > 0
    && !path.includes('\0')
    && !posix.isAbsolute(path)
    && path !== '.'
    && path !== '..'
    && !path.startsWith('../')
    && posix.normalize(path) === path;
}

function collectWorkingTreeDiff(
  cwd: string,
  baseRange: ReviewScopeBaseRange,
  paths: readonly string[],
): string | undefined {
  if (baseRange.kind === 'no_commits') {
    return undefined;
  }
  const range = baseRange.kind === 'branch_base' ? baseRange.baseCommit : 'HEAD';
  return collectDiffText(cwd, range, paths);
}

function collectReviewScopeDiff(
  cwd: string,
  scope: Extract<TaskReviewScope, { kind: 'collected' }>,
  paths: readonly string[],
): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  if (scope.source.kind === 'working_tree') {
    return collectWorkingTreeDiff(cwd, scope.source.baseRange, paths);
  }
  const sections: string[] = [];
  if (scope.source.diffRange !== undefined) {
    const diff = collectDiffText(
      cwd,
      `${scope.source.diffRange.baseDiffRef}...${scope.source.diffRange.headDiffRef}`,
      paths,
    );
    if (diff !== undefined) sections.push(diff);
  }
  if (scope.source.includesWorkingTree && scope.source.baseRange.kind !== 'no_commits') {
    const diff = collectWorkingTreeDiff(cwd, scope.source.baseRange, paths);
    if (diff !== undefined) sections.push(diff);
  }
  return sections.length === 0 ? undefined : sections.join('\n\n');
}

function decodeUtf8(content: Buffer): string | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  const decoded = content.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(content) ? decoded : undefined;
}

function addOmission(
  counts: Map<CompletionRetryEvidenceOmissionReason, number>,
  reason: CompletionRetryEvidenceOmissionReason,
  count = 1,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + count);
}

function omissionsFrom(
  counts: ReadonlyMap<CompletionRetryEvidenceOmissionReason, number>,
): CompletionRetryEvidenceOmission[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([reason, count]) => ({ reason, count }));
}

function buildEvidence(
  files: readonly CompletionRetryEvidenceFile[],
  diff: string | undefined,
  references: readonly CompletionRetryReferenceEvidence[],
  priorGapPaths: readonly string[],
  omissionCounts: ReadonlyMap<CompletionRetryEvidenceOmissionReason, number>,
): CompletionRetryEvidence {
  return {
    status: files.length === 0
      && diff === undefined
      && references.length === 0
      && priorGapPaths.length === 0
      ? 'omitted'
      : 'collected',
    files,
    ...(diff === undefined ? {} : { diff }),
    references,
    priorGapPaths,
    omissions: omissionsFrom(omissionCounts),
  };
}

function enforceSerializedLimit(
  files: CompletionRetryEvidenceFile[],
  diff: string | undefined,
  references: CompletionRetryReferenceEvidence[],
  priorGapPaths: string[],
  omissionCounts: Map<CompletionRetryEvidenceOmissionReason, number>,
): CompletionRetryEvidence {
  let currentDiff = diff;
  let evidence = buildEvidence(
    files,
    currentDiff,
    references,
    priorGapPaths,
    omissionCounts,
  );
  let excess = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
    - COMPLETION_RETRY_EVIDENCE_MAX_TOTAL_BYTES;
  while (excess > 0 && currentDiff !== undefined) {
    const retainedBytes = Math.max(0, Buffer.byteLength(currentDiff, 'utf8') - excess);
    currentDiff = retainedBytes === 0 ? undefined : truncateUtf8(currentDiff, retainedBytes).value;
    addOmission(omissionCounts, 'total_size_limit');
    evidence = buildEvidence(
      files,
      currentDiff,
      references,
      priorGapPaths,
      omissionCounts,
    );
    excess = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
      - COMPLETION_RETRY_EVIDENCE_MAX_TOTAL_BYTES;
  }
  const trimTrailingItems = <T>(
    items: T[],
    reason: CompletionRetryEvidenceOmissionReason,
    buildCandidate: (
      retainedItems: T[],
      omissions: ReadonlyMap<CompletionRetryEvidenceOmissionReason, number>,
    ) => CompletionRetryEvidence,
  ): void => {
    if (items.length === 0
      || Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= COMPLETION_RETRY_EVIDENCE_MAX_TOTAL_BYTES) {
      return;
    }
    const originalLength = items.length;
    let minimumRemoved = 1;
    let maximumRemoved = originalLength;
    while (minimumRemoved < maximumRemoved) {
      const removed = Math.floor((minimumRemoved + maximumRemoved) / 2);
      const candidateOmissions = new Map(omissionCounts);
      addOmission(candidateOmissions, reason, removed);
      const retainedItems = items.slice(0, originalLength - removed);
      const candidate = buildCandidate(retainedItems, candidateOmissions);
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= COMPLETION_RETRY_EVIDENCE_MAX_TOTAL_BYTES) {
        maximumRemoved = removed;
      } else {
        minimumRemoved = removed + 1;
      }
    }
    items.splice(originalLength - minimumRemoved, minimumRemoved);
    addOmission(omissionCounts, reason, minimumRemoved);
    evidence = buildEvidence(
      files,
      currentDiff,
      references,
      priorGapPaths,
      omissionCounts,
    );
  };
  trimTrailingItems(files, 'total_size_limit', (retained, omissions) => buildEvidence(
    retained,
    currentDiff,
    references,
    priorGapPaths,
    omissions,
  ));
  trimTrailingItems(references, 'total_size_limit', (retained, omissions) => buildEvidence(
    files,
    currentDiff,
    retained,
    priorGapPaths,
    omissions,
  ));
  trimTrailingItems(priorGapPaths, 'total_size_limit', (retained, omissions) => buildEvidence(
    files,
    currentDiff,
    references,
    retained,
    omissions,
  ));
  return evidence;
}

function collectPriorGapPaths(input: {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly excludedPaths: ReadonlySet<string>;
  readonly omissionCounts: Map<CompletionRetryEvidenceOmissionReason, number>;
}): string[] {
  const novelPaths = [...new Set(input.paths)]
    .filter((path) => !input.excludedPaths.has(path));
  const boundedPaths = novelPaths.slice(0, COMPLETION_RETRY_EVIDENCE_MAX_PRIOR_GAP_PATHS);
  if (novelPaths.length > boundedPaths.length) {
    addOmission(input.omissionCounts, 'path_limit', novelPaths.length - boundedPaths.length);
  }
  const candidates = boundedPaths.filter((path) => {
    if (!isCanonicalRepositoryPath(path)) {
      addOmission(input.omissionCounts, 'prior_gap_path_unverified');
      return false;
    }
    if (Buffer.byteLength(path, 'utf8') > COMPLETION_RETRY_EVIDENCE_MAX_PATH_BYTES) {
      addOmission(input.omissionCounts, 'path_size_limit');
      return false;
    }
    if (isSensitiveProjectFilePath(path)) {
      addOmission(input.omissionCounts, 'sensitive_path');
      return false;
    }
    return true;
  });
  let trackedPaths: Set<string> | undefined;
  try {
    trackedPaths = trackedPriorGapPaths(input.cwd, candidates);
  } catch {
    addOmission(input.omissionCounts, 'prior_gap_path_unverified', candidates.length);
  }
  const admittedPaths: string[] = [];
  if (trackedPaths === undefined) return admittedPaths;
  for (const path of candidates) {
    if (!trackedPaths.has(path)) {
      addOmission(input.omissionCounts, 'prior_gap_path_unverified');
      continue;
    }
    try {
      const inspected = assertPathSegmentsAreSafe(
        input.cwd,
        resolve(input.cwd, path),
        (_violation, segmentPath) => new Error(`Unsafe completion retry reference path: ${segmentPath}`),
      );
      if (inspected === null || !inspected.isFile()) {
        addOmission(input.omissionCounts, 'prior_gap_path_unverified');
        continue;
      }
    } catch {
      addOmission(input.omissionCounts, 'prior_gap_path_unverified');
      continue;
    }
    admittedPaths.push(path);
  }
  return admittedPaths;
}

export function collectCompletionRetryEvidence(input: {
  readonly cwd: string;
  readonly reviewScope: TaskReviewScope | undefined;
  readonly priorGapPaths?: readonly string[];
}): CompletionRetryEvidence {
  const omissionCounts = new Map<CompletionRetryEvidenceOmissionReason, number>();
  if (input.reviewScope === undefined || input.reviewScope.kind !== 'collected') {
    addOmission(omissionCounts, 'unsupported_scope');
    return buildEvidence([], undefined, [], [], omissionCounts);
  }
  const reviewScope = input.reviewScope;

  const selectedPaths = reviewScope.paths.slice(0, COMPLETION_RETRY_EVIDENCE_MAX_PATHS);
  if (reviewScope.paths.length > selectedPaths.length) {
    addOmission(
      omissionCounts,
      'path_limit',
      reviewScope.paths.length - selectedPaths.length,
    );
  }

  const files: CompletionRetryEvidenceFile[] = [];
  const diffPaths: string[] = [];
  for (const path of selectedPaths) {
    if (Buffer.byteLength(path, 'utf8') > COMPLETION_RETRY_EVIDENCE_MAX_PATH_BYTES) {
      addOmission(omissionCounts, 'path_size_limit');
      continue;
    }
    if (isSensitiveProjectFilePath(path)) {
      addOmission(omissionCounts, 'sensitive_path');
      continue;
    }
    let inspectedStat: ReturnType<typeof assertPathSegmentsAreSafe>;
    try {
      inspectedStat = assertPathSegmentsAreSafe(
        input.cwd,
        resolve(input.cwd, path),
        (_violation, segmentPath) => new Error(`Unsafe completion retry evidence path: ${segmentPath}`),
      );
    } catch {
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    if (inspectedStat === null) {
      // Deleted files have no source body to read, but their repository-relative
      // path remains safe to pass to git so the deletion itself stays reviewable.
      diffPaths.push(path);
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    const resolution = resolveCompletionRetryPath(input.cwd, path);
    if (!resolution.ok) {
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    if (resolution.stat.size > COMPLETION_RETRY_EVIDENCE_MAX_FILE_BYTES) {
      addOmission(omissionCounts, 'file_size_limit');
      continue;
    }
    let rawContent: Buffer;
    try {
      rawContent = readRegularFileNoFollow(resolution.realPath, resolution.stat);
    } catch {
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    const decoded = decodeUtf8(rawContent);
    if (decoded === undefined) {
      addOmission(omissionCounts, 'binary_file');
      continue;
    }
    const sanitized = sanitizeSensitiveText(decoded);
    const bounded = truncateUtf8(sanitized, COMPLETION_RETRY_EVIDENCE_MAX_FILE_BYTES);
    files.push({
      path,
      content: bounded.value,
      truncated: bounded.bytes < Buffer.byteLength(sanitized, 'utf8'),
    });
    diffPaths.push(path);
  }

  let diff: string | undefined;
  try {
    const collectedDiff = collectReviewScopeDiff(input.cwd, reviewScope, diffPaths);
    if (collectedDiff !== undefined) {
      const sanitizedDiff = sanitizeSensitiveText(collectedDiff);
      const boundedDiff = truncateUtf8(
        sanitizedDiff,
        COMPLETION_RETRY_EVIDENCE_MAX_DIFF_BYTES,
      );
      diff = boundedDiff.value;
      if (boundedDiff.bytes < Buffer.byteLength(sanitizedDiff, 'utf8')) {
        addOmission(omissionCounts, 'diff_size_limit');
      }
    }
  } catch {
    addOmission(omissionCounts, 'diff_unavailable');
  }

  const selectedPathSet = new Set(selectedPaths);
  const priorGapPaths = collectPriorGapPaths({
    cwd: input.cwd,
    paths: input.priorGapPaths ?? [],
    excludedPaths: selectedPathSet,
    omissionCounts,
  });
  const discovered = discoverCompletionRetryReferences({
    cwd: input.cwd,
    changedFiles: files.map(({ path, content }) => ({ path, content })),
    diff,
    excludedPaths: new Set([...selectedPathSet, ...priorGapPaths]),
    limits: {
      maxPathBytes: COMPLETION_RETRY_EVIDENCE_MAX_PATH_BYTES,
      maxFileBytes: COMPLETION_RETRY_EVIDENCE_MAX_FILE_BYTES,
    },
  });
  for (const [reason, count] of discovered.omissions) {
    addOmission(omissionCounts, reason, count);
  }

  return enforceSerializedLimit(
    files,
    diff,
    [...discovered.references],
    priorGapPaths,
    omissionCounts,
  );
}
