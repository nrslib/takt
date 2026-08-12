import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readRegularFileNoFollow } from '../../shared/utils/private-file.js';
import { isSensitiveProjectFilePath } from '../../shared/utils/sensitive-file-path.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { assertPathSegmentsAreSafe } from '../../shared/utils/pathBoundary.js';
import type { ReviewScopeBaseRange, TaskReviewScope } from './review-scope.js';
import { resolveRealPathWithinProject } from './findings/admission-validation.js';

export const REVIEW_COMPLETION_EVIDENCE_MAX_PATHS = 64;
export const REVIEW_COMPLETION_EVIDENCE_MAX_PATH_BYTES = 1024;
export const REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES = 32 * 1024;
export const REVIEW_COMPLETION_EVIDENCE_MAX_DIFF_BYTES = 256 * 1024;
export const REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES = 512 * 1024;

type ReviewCompletionEvidenceOmissionReason =
  | 'binary_file'
  | 'diff_size_limit'
  | 'diff_unavailable'
  | 'file_size_limit'
  | 'file_unavailable'
  | 'path_limit'
  | 'path_size_limit'
  | 'sensitive_path'
  | 'total_size_limit'
  | 'unsupported_scope';

export interface ReviewCompletionEvidenceFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ReviewCompletionEvidenceOmission {
  readonly reason: ReviewCompletionEvidenceOmissionReason;
  readonly count: number;
}

export interface ReviewCompletionEvidence {
  readonly status: 'collected' | 'omitted';
  readonly files: readonly ReviewCompletionEvidenceFile[];
  readonly diff?: string;
  readonly omissions: readonly ReviewCompletionEvidenceOmission[];
}

function collectDiffText(cwd: string, range: string, paths: readonly string[]): string | undefined {
  const output = execFileSync(
    'git',
    ['diff', '--no-ext-diff', '--no-textconv', range, '--', ...paths],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: REVIEW_COMPLETION_EVIDENCE_MAX_DIFF_BYTES,
    },
  );
  const decoded = decodeUtf8(output);
  if (decoded === undefined) {
    throw new Error('Review completion diff is not UTF-8 text');
  }
  const trimmed = decoded.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
    const diff = collectDiffText(cwd, 'HEAD', paths);
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
  counts: Map<ReviewCompletionEvidenceOmissionReason, number>,
  reason: ReviewCompletionEvidenceOmissionReason,
  count = 1,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + count);
}

function omissionsFrom(
  counts: ReadonlyMap<ReviewCompletionEvidenceOmissionReason, number>,
): ReviewCompletionEvidenceOmission[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([reason, count]) => ({ reason, count }));
}

function buildEvidence(
  files: readonly ReviewCompletionEvidenceFile[],
  diff: string | undefined,
  omissionCounts: ReadonlyMap<ReviewCompletionEvidenceOmissionReason, number>,
): ReviewCompletionEvidence {
  return {
    status: files.length === 0 && diff === undefined ? 'omitted' : 'collected',
    files,
    ...(diff === undefined ? {} : { diff }),
    omissions: omissionsFrom(omissionCounts),
  };
}

function enforceSerializedLimit(
  files: ReviewCompletionEvidenceFile[],
  diff: string | undefined,
  omissionCounts: Map<ReviewCompletionEvidenceOmissionReason, number>,
): ReviewCompletionEvidence {
  let currentDiff = diff;
  let evidence = buildEvidence(files, currentDiff, omissionCounts);
  let excess = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
    - REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES;
  while (excess > 0 && currentDiff !== undefined) {
    const retainedBytes = Math.max(0, Buffer.byteLength(currentDiff, 'utf8') - excess);
    currentDiff = retainedBytes === 0 ? undefined : truncateUtf8(currentDiff, retainedBytes).value;
    addOmission(omissionCounts, 'total_size_limit');
    evidence = buildEvidence(files, currentDiff, omissionCounts);
    excess = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
      - REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES;
  }
  while (
    files.length > 0
    && Buffer.byteLength(JSON.stringify(evidence), 'utf8') > REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES
  ) {
    files.pop();
    addOmission(omissionCounts, 'total_size_limit');
    evidence = buildEvidence(files, currentDiff, omissionCounts);
  }
  return evidence;
}

export function collectReviewCompletionEvidence(input: {
  readonly cwd: string;
  readonly reviewScope: TaskReviewScope | undefined;
}): ReviewCompletionEvidence {
  const omissionCounts = new Map<ReviewCompletionEvidenceOmissionReason, number>();
  if (input.reviewScope === undefined || input.reviewScope.kind !== 'collected') {
    addOmission(omissionCounts, 'unsupported_scope');
    return buildEvidence([], undefined, omissionCounts);
  }

  const selectedPaths = input.reviewScope.paths.slice(0, REVIEW_COMPLETION_EVIDENCE_MAX_PATHS);
  if (input.reviewScope.paths.length > selectedPaths.length) {
    addOmission(
      omissionCounts,
      'path_limit',
      input.reviewScope.paths.length - selectedPaths.length,
    );
  }

  const files: ReviewCompletionEvidenceFile[] = [];
  const diffPaths: string[] = [];
  for (const path of selectedPaths) {
    if (Buffer.byteLength(path, 'utf8') > REVIEW_COMPLETION_EVIDENCE_MAX_PATH_BYTES) {
      addOmission(omissionCounts, 'path_size_limit');
      continue;
    }
    if (isSensitiveProjectFilePath(path)) {
      addOmission(omissionCounts, 'sensitive_path');
      continue;
    }
    try {
      assertPathSegmentsAreSafe(
        input.cwd,
        resolve(input.cwd, path),
        (_violation, segmentPath) => new Error(`Unsafe review completion evidence path: ${segmentPath}`),
      );
    } catch {
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    const resolution = resolveRealPathWithinProject(input.cwd, path);
    if (!resolution.ok) {
      addOmission(omissionCounts, 'file_unavailable');
      continue;
    }
    if (resolution.stat.size > REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES) {
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
    const bounded = truncateUtf8(sanitized, REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES);
    files.push({
      path,
      content: bounded.value,
      truncated: bounded.bytes < Buffer.byteLength(sanitized, 'utf8'),
    });
    diffPaths.push(path);
  }

  let diff: string | undefined;
  try {
    const collectedDiff = collectReviewScopeDiff(input.cwd, input.reviewScope, diffPaths);
    if (collectedDiff !== undefined) {
      const sanitizedDiff = sanitizeSensitiveText(collectedDiff);
      const boundedDiff = truncateUtf8(
        sanitizedDiff,
        REVIEW_COMPLETION_EVIDENCE_MAX_DIFF_BYTES,
      );
      diff = boundedDiff.value;
      if (boundedDiff.bytes < Buffer.byteLength(sanitizedDiff, 'utf8')) {
        addOmission(omissionCounts, 'diff_size_limit');
      }
    }
  } catch {
    addOmission(omissionCounts, 'diff_unavailable');
  }

  return enforceSerializedLimit(files, diff, omissionCounts);
}
