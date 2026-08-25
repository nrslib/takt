import { basename, join } from 'node:path';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import {
  ensurePrivateDirectory,
  readPrivateFileState,
  writePrivateFile,
} from '../../../shared/utils/private-file.js';
import { LOOP_ANALYSIS_REPORT_FILE } from './loopAnalysis.js';

const LOOP_ANALYSIS_ARCHIVE_DIRECTORY = 'loop-analysis';
const LOOP_ANALYSIS_SOURCE_FILE = 'source.json';
const LOOP_ANALYSIS_ARCHIVE_VERSION = 1;

export interface LoopAnalysisPullRequestReference {
  readonly number: number;
  readonly url: string;
}

export interface LoopAnalysisArchiveMetadata {
  readonly version: 1;
  readonly sourceRunDirectory: string;
  readonly projectCwd: string;
  readonly branch?: string;
  readonly analysisReportPath: string;
  readonly archivedAt: string;
  readonly pullRequest?: LoopAnalysisPullRequestReference;
}

export interface LoopAnalysisArchive {
  readonly sourceMetadataPath: string;
  readonly metadata: LoopAnalysisArchiveMetadata;
}

export interface ArchiveLoopAnalysisReportOptions {
  readonly sourceRunDirectory: string;
  readonly projectCwd: string;
  readonly analysisReportPath: string;
  readonly branch?: string;
}

export function archiveLoopAnalysisReport(
  options: ArchiveLoopAnalysisReportOptions,
): LoopAnalysisArchive {
  const snapshot = readPrivateFileState(options.analysisReportPath);
  if (!('content' in snapshot)) {
    throw new Error('Loop analysis report is no longer available');
  }

  const sourceRunSlug = basename(options.sourceRunDirectory);
  if (sourceRunSlug.length === 0) {
    throw new Error('Loop analysis source run directory must have a basename');
  }
  const archiveDirectory = join(
    getGlobalConfigDir(),
    LOOP_ANALYSIS_ARCHIVE_DIRECTORY,
    sourceRunSlug,
  );
  ensurePrivateDirectory(archiveDirectory);

  const metadata: LoopAnalysisArchiveMetadata = {
    version: LOOP_ANALYSIS_ARCHIVE_VERSION,
    sourceRunDirectory: options.sourceRunDirectory,
    projectCwd: options.projectCwd,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    analysisReportPath: options.analysisReportPath,
    archivedAt: new Date().toISOString(),
  };
  writePrivateFile(
    join(archiveDirectory, LOOP_ANALYSIS_REPORT_FILE),
    snapshot.content.toString('utf8'),
  );
  const sourceMetadataPath = join(archiveDirectory, LOOP_ANALYSIS_SOURCE_FILE);
  writePrivateFile(
    sourceMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return { sourceMetadataPath, metadata };
}

export function recordLoopAnalysisPullRequest(
  archive: LoopAnalysisArchive,
  pullRequest: LoopAnalysisPullRequestReference,
): void {
  const metadata: LoopAnalysisArchiveMetadata = {
    ...archive.metadata,
    pullRequest,
  };
  writePrivateFile(
    archive.sourceMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}
