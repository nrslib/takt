import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { getErrorMessage, isPathInside, isValidReportDirName } from '../../shared/utils/index.js';
import { workflowCallNamespacePathsMatch, workflowCallNamespaceSegmentsMatch } from './workflow-call-namespace.js';
import { scanReportEntries } from './report-file-index.js';

const MAX_REPORT_ENTRIES = 1_024;
const MAX_REPORT_SIZE_BYTES = 1_048_576;

type ReviewReportInheritanceStatus = 'copied' | 'partial' | 'unavailable';

interface ReviewReportInheritanceResult {
  readonly sourceRunSlug?: string;
  readonly sourceReportDirectory?: string;
  readonly targetReportDirectory: string;
  readonly status: ReviewReportInheritanceStatus;
  readonly fallbackUsed: boolean;
  readonly copied: ReadonlyArray<{ reportName: string; sourcePath: string; targetPath: string }>;
  readonly skipped: ReadonlyArray<{ reportName: string; reason: string; sourcePath?: string }>;
}

interface InheritReviewReportsOptions {
  readonly cwd: string;
  readonly sourceRunSlug?: string;
  readonly currentRunSlug: string;
  readonly targetReportDirectory: string;
  readonly reviewReportNames: readonly string[];
  readonly discoveryFailures?: readonly string[];
}

interface Candidate {
  readonly path: string;
  readonly mtimeMs: number;
  readonly targetRelativePath: string;
}

function reportRoot(cwd: string, runSlug: string): string {
  return resolve(cwd, '.takt', 'runs', runSlug, 'reports');
}

function isSafeRelativeReportPath(path: string): boolean {
  if (!path || path === '.' || path.includes('\0') || /^[A-Za-z]:\//.test(path)) return false;
  const root = resolve(sep, 'takt-report-path-root');
  const candidate = resolve(root, path);
  return !path.startsWith(sep) && isPathInside(root, candidate) && candidate !== root;
}

function normalizeReportPath(reportName: string): string | undefined {
  const normalized = reportName.replace(/\\/g, '/');
  return isSafeRelativeReportPath(normalized) ? normalized : undefined;
}

function candidateFor(
  root: string,
  entries: readonly string[],
  targetNamespace: string[],
  reportName: string,
): Candidate | undefined {
  const normalizedReportName = normalizeReportPath(reportName);
  if (!normalizedReportName) return undefined;
  const reportSegments = normalizedReportName.split('/');
  const reportPathSegments = reportPathAfterNamespace(reportSegments, targetNamespace);
  const candidates = entries
    .filter((path) => {
      const candidateSegments = relative(root, path).split(sep);
      if (candidateSegments.length < reportPathSegments.length) return false;
      const candidateReportSegments = candidateSegments.slice(-reportPathSegments.length);
      const candidateNamespace = candidateSegments.slice(0, -reportPathSegments.length);
      return workflowCallNamespacePathsMatch(candidateReportSegments, reportPathSegments)
        && workflowCallNamespacePathsMatch(candidateNamespace, targetNamespace);
    })
    .map((path) => ({
      path,
      mtimeMs: lstatSync(path).mtimeMs,
      targetRelativePath: relative(root, path).split(sep).slice(targetNamespace.length).join(sep),
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || relative(root, left.path).localeCompare(relative(root, right.path)));
  return candidates.find((candidate) => !lstatSync(candidate.path).isDirectory()) ?? candidates[0];
}

function reportPathAfterNamespace(reportSegments: string[], targetNamespace: string[]): string[] {
  const hasNamespacePrefix = reportSegments.length > targetNamespace.length
    && targetNamespace.every((segment, index) => workflowCallNamespaceSegmentsMatch(segment, reportSegments[index]!));
  return hasNamespacePrefix ? reportSegments.slice(targetNamespace.length) : reportSegments;
}

function validateCandidate(candidate: Candidate, sourceReportDirectory: string): string | undefined {
  const info = lstatSync(candidate.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) return 'invalid_source';
  if (info.size > MAX_REPORT_SIZE_BYTES) return `source_too_large:${MAX_REPORT_SIZE_BYTES}`;
  if ((info.mode & 0o444) === 0) return 'read_failed';
  try {
    if (!isPathInside(realpathSync(sourceReportDirectory), realpathSync(candidate.path))) return 'invalid_source';
    new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(candidate.path));
  } catch (error) {
    return error instanceof TypeError ? 'invalid_format' : 'read_failed';
  }
  return undefined;
}

function resolveSourceReportDirectory(options: InheritReviewReportsOptions): string | undefined {
  if (!options.sourceRunSlug || !isValidReportDirName(options.sourceRunSlug) || options.sourceRunSlug === options.currentRunSlug) return undefined;
  const runsDirectory = resolve(options.cwd, '.takt', 'runs');
  const sourceRunDirectory = resolve(runsDirectory, options.sourceRunSlug);
  const sourceReportDirectory = join(sourceRunDirectory, 'reports');
  if (!isPathInside(runsDirectory, sourceRunDirectory)) return undefined;
  try {
    if (!isPathInside(realpathSync(runsDirectory), realpathSync(sourceRunDirectory))) return undefined;
    if (!existsSync(sourceReportDirectory)) return sourceReportDirectory;
    if (!isPathInside(realpathSync(runsDirectory), realpathSync(sourceReportDirectory))) return undefined;
  } catch (error) {
    throw new Error(`source_resolution_failed:${getErrorMessage(error)}`);
  }
  return sourceReportDirectory;
}

function ensureSafeDestinationDirectory(cwd: string, currentRunSlug: string, targetDirectory: string): void {
  const root = reportRoot(cwd, currentRunSlug);
  const resolvedTarget = resolve(targetDirectory);
  if (!isPathInside(root, resolvedTarget) && resolvedTarget !== root) {
    throw new Error('target_report_directory_outside_current_run');
  }
  const segments = relative(resolve(cwd), resolvedTarget).split(sep).filter(Boolean);
  let current = resolve(cwd);
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current);
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error('target_report_directory_contains_symlink');
    }
  }
  if (!isPathInside(realpathSync(root), realpathSync(resolvedTarget))) {
    throw new Error('target_report_directory_resolves_outside_current_run');
  }
}

function targetNamespace(options: InheritReviewReportsOptions): string[] {
  return relative(reportRoot(options.cwd, options.currentRunSlug), resolve(options.targetReportDirectory))
    .split(sep)
    .filter(Boolean);
}

export function inheritReviewReports(options: InheritReviewReportsOptions): ReviewReportInheritanceResult {
  const copied: Array<{ reportName: string; sourcePath: string; targetPath: string }> = [];
  const skipped: Array<{ reportName: string; reason: string; sourcePath?: string }> = (options.discoveryFailures ?? [])
    .map((reason) => ({ reportName: '*', reason }));
  const names = options.reviewReportNames.slice(0, MAX_REPORT_ENTRIES);
  if (names.length !== options.reviewReportNames.length) {
    skipped.push({ reportName: '*', reason: `report_name_limit_exceeded:${MAX_REPORT_ENTRIES}` });
  }
  try {
    ensureSafeDestinationDirectory(options.cwd, options.currentRunSlug, options.targetReportDirectory);
  } catch (error) {
    for (const reportName of names) skipped.push({ reportName, reason: `target_unavailable:${getErrorMessage(error)}` });
    return buildResult(options, undefined, copied, skipped);
  }
  let sourceReportDirectory: string | undefined;
  try {
    sourceReportDirectory = resolveSourceReportDirectory(options);
  } catch (error) {
    for (const reportName of names) {
      skipped.push({ reportName, reason: getErrorMessage(error) });
    }
    return buildResult(options, undefined, copied, skipped);
  }
  if (!sourceReportDirectory) {
    for (const reportName of names) skipped.push({ reportName, reason: 'source_unavailable' });
    return buildResult(options, sourceReportDirectory, copied, skipped);
  }
  const namespace = targetNamespace(options);
  const scan = existsSync(sourceReportDirectory)
    ? scanReportEntries(sourceReportDirectory)
    : { entries: [] };
  for (const reportName of names) {
    const candidate = candidateFor(sourceReportDirectory, scan.entries, namespace, reportName);
    if (!candidate) {
      skipped.push({ reportName, reason: scan.failure ? `scan_failed:${scan.failure}` : 'not_found' });
      continue;
    }
    let invalidReason: string | undefined;
    try { invalidReason = validateCandidate(candidate, sourceReportDirectory); } catch (error) {
      skipped.push({ reportName, reason: `validation_failed:${getErrorMessage(error)}`, sourcePath: candidate.path }); continue;
    }
    if (invalidReason) { skipped.push({ reportName, reason: invalidReason, sourcePath: candidate.path }); continue; }
    const targetPath = resolve(options.targetReportDirectory, candidate.targetRelativePath);
    if (!isPathInside(options.targetReportDirectory, targetPath)) {
      skipped.push({ reportName, reason: 'invalid_report_name', sourcePath: candidate.path }); continue;
    }
    try {
      ensureSafeDestinationDirectory(options.cwd, options.currentRunSlug, join(targetPath, '..'));
      copyFileSync(candidate.path, targetPath, constants.COPYFILE_EXCL);
      chmodSync(targetPath, lstatSync(targetPath).mode | 0o200);
      copied.push({ reportName, sourcePath: candidate.path, targetPath });
    } catch (error) {
      skipped.push({ reportName, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'target_exists' : `copy_failed:${getErrorMessage(error)}`, sourcePath: candidate.path });
    }
  }
  return buildResult(options, sourceReportDirectory, copied, skipped);
}

function buildResult(
  options: InheritReviewReportsOptions,
  sourceReportDirectory: string | undefined,
  copied: ReviewReportInheritanceResult['copied'],
  skipped: ReviewReportInheritanceResult['skipped'],
): ReviewReportInheritanceResult {
  const status: ReviewReportInheritanceStatus = copied.length === options.reviewReportNames.length
    && copied.length > 0
    && skipped.length === 0
    ? 'copied'
    : copied.length > 0 || skipped.some((entry) => entry.reason === 'target_exists') ? 'partial' : 'unavailable';
  return {
    ...(options.sourceRunSlug ? { sourceRunSlug: options.sourceRunSlug } : {}),
    ...(sourceReportDirectory ? { sourceReportDirectory } : {}),
    targetReportDirectory: options.targetReportDirectory,
    status,
    fallbackUsed: status !== 'copied',
    copied,
    skipped,
  };
}

export function writeReviewReportInheritanceDiagnostic(options: InheritReviewReportsOptions, result: ReviewReportInheritanceResult): void {
  ensureSafeDestinationDirectory(options.cwd, options.currentRunSlug, options.targetReportDirectory);
  writeFileSync(join(options.targetReportDirectory, 'review-report-inheritance.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
}
