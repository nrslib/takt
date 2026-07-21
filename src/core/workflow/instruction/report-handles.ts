import { existsSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type { WorkflowStep } from '../../models/types.js';
import { getReportFiles } from '../evaluation/rule-utils.js';
import { scanReportEntries } from '../report-file-index.js';
import { resolveReviewReportSourceSteps } from '../review-report-discovery.js';
import { workflowCallNamespacePathsMatch } from '../workflow-call-namespace.js';

const REPORT_HISTORY_PATTERN = /^(?<base>.+)\.(?<timestamp>\d{8}T\d{6}Z)(?:\.(?<sequence>\d+))?$/;
const REPORT_PATH_SEPARATOR = '/';

interface ResolvedReportPath {
  readonly reportName: string;
  readonly path: string;
}

interface CurrentReviewReportPathsResult {
  readonly paths: readonly ResolvedReportPath[];
  readonly scanFailure?: string;
}

interface ReportHistoryEntry {
  readonly path: string;
  readonly timestamp: string;
  readonly sequence: number;
}

interface ResolvedReportHandles {
  readonly currentReport: string;
  readonly previousReport: string;
  readonly reportHistory: string;
  readonly peerReports: string;
}

interface ReportHandleResolverContext {
  readonly step: WorkflowStep;
  readonly reportDir: string;
  readonly workflowSteps: ReadonlyArray<WorkflowStep>;
  readonly inheritedPeerReportPaths?: readonly string[];
}

export function resolveCurrentReviewReportPathsWithDiagnostics(
  reportDir: string,
  reportNames: readonly string[],
  excludedPaths: ReadonlySet<string>,
): CurrentReviewReportPathsResult {
  const scan = existsSync(reportDir) ? scanReportEntries(reportDir) : { entries: [] };
  const statByPath = new Map<string, Stats>();
  const statFor = (path: string): Stats => {
    const cached = statByPath.get(path);
    if (cached) return cached;
    const stat = lstatSync(path);
    statByPath.set(path, stat);
    return stat;
  };
  const paths = reportNames.flatMap((reportName) => {
    const matchingPaths = scan.entries
      .filter((path) => !excludedPaths.has(path) && reportPathMatches(path, reportDir, reportName) && statFor(path).isFile())
      .sort((left, right) => statFor(right).mtimeMs - statFor(left).mtimeMs || left.localeCompare(right));
    const path = matchingPaths[0];
    return path ? [{ reportName, path }] : [];
  });
  return scan.failure ? { paths, scanFailure: scan.failure } : { paths };
}

export function resolveReportHandles(context: ReportHandleResolverContext): ResolvedReportHandles {
  const currentReportPaths = resolveCurrentReportPaths(context.reportDir, context.step);
  const stepReportFiles = getReportFiles(context.step.outputContracts);
  const historyByFile = stepReportFiles.map((fileName) => resolveReportHistory(context.reportDir, fileName));
  const peerReportPaths = resolveReviewReportSourceSteps(context.step, context.workflowSteps)
    .flatMap((peerStep) => resolveCurrentReportPaths(context.reportDir, peerStep));
  const allPeerReportPaths = [...new Set([
    ...peerReportPaths,
    ...(context.inheritedPeerReportPaths ?? []),
  ])];

  return {
    currentReport: currentReportPaths.join('\n'),
    previousReport: historyByFile
      .map((entries) => entries[0]?.path)
      .filter((path): path is string => path !== undefined)
      .join('\n'),
    reportHistory: historyByFile
      .flatMap((entries) => entries.map((entry) => entry.path))
      .join('\n'),
    peerReports: allPeerReportPaths.join('\n'),
  };
}

function reportPathMatches(path: string, reportDir: string, reportName: string): boolean {
  const pathSegments = relativePathSegments(reportDir, path);
  const reportSegments = reportName.replace(/\\/g, REPORT_PATH_SEPARATOR).split(REPORT_PATH_SEPARATOR);
  return workflowCallNamespacePathsMatch(pathSegments, reportSegments);
}

function relativePathSegments(root: string, path: string): string[] {
  return relative(root, path).split(/[/\\\\]/);
}

function resolveCurrentReportPaths(reportDir: string, step: WorkflowStep): string[] {
  return getReportFiles(step.outputContracts)
    .map((fileName) => join(reportDir, fileName))
    .filter((filePath) => existsSync(filePath));
}

function resolveReportHistory(reportDir: string, fileName: string): ReportHistoryEntry[] {
  if (!existsSync(reportDir)) {
    return [];
  }

  return readdirSync(reportDir)
    .map((entryName) => parseHistoryEntry(reportDir, fileName, entryName))
    .filter((entry): entry is ReportHistoryEntry => entry !== undefined)
    .sort(compareHistoryEntries);
}

function parseHistoryEntry(
  reportDir: string,
  fileName: string,
  entryName: string,
): ReportHistoryEntry | undefined {
  const match = REPORT_HISTORY_PATTERN.exec(entryName);
  if (!match?.groups || match.groups.base !== fileName || !match.groups.timestamp) {
    return undefined;
  }

  return {
    path: join(reportDir, entryName),
    timestamp: match.groups.timestamp,
    sequence: Number.parseInt(match.groups.sequence ?? '0', 10),
  };
}

function compareHistoryEntries(left: ReportHistoryEntry, right: ReportHistoryEntry): number {
  if (left.timestamp !== right.timestamp) {
    return right.timestamp.localeCompare(left.timestamp);
  }
  return right.sequence - left.sequence;
}
