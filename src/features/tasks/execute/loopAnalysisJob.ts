import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
  writePrivateFile,
} from '../../../shared/utils/private-file.js';
import { getErrorMessage } from '../../../shared/utils/index.js';

const LOOP_ANALYSIS_JOB_VERSION = 1;
const LOOP_ANALYSIS_JOB_DIRECTORY = 'loop-analysis';
const LOOP_ANALYSIS_WORKER_FAILURE_LOG = 'worker-errors.jsonl';
const LOOP_ANALYSIS_DISPATCH_CLAIM = 'dispatch.claim';
const PRIVATE_FILE_MODE = 0o600;

export type LoopAnalysisOutput = 'file' | 'pr-comment';

export interface LoopAnalysisJob {
  readonly version: 1;
  readonly projectCwd: string;
  readonly sourceRunDirectory: string;
  readonly output: LoopAnalysisOutput;
  readonly parentPid: number;
  readonly branch?: string;
  readonly publicationMarkerPath?: string;
}

export interface LoopAnalysisJobPaths {
  readonly jobPath: string;
  readonly publicationMarkerPath: string;
}

export type LoopAnalysisPublicationState = 'pending' | 'settled';

interface LoopAnalysisPublicationMarker {
  readonly version: 1;
  readonly state: LoopAnalysisPublicationState;
}

export function claimLoopAnalysisDispatch(sourceRunDirectory: string): boolean {
  requireAbsolutePath(sourceRunDirectory, 'sourceRunDirectory');
  const directory = join(
    sourceRunDirectory,
    '.takt-report-internal',
    LOOP_ANALYSIS_JOB_DIRECTORY,
  );
  ensurePrivateDirectory(directory);
  try {
    closeSync(openSync(
      join(directory, LOOP_ANALYSIS_DISPATCH_CLAIM),
      'wx',
      PRIVATE_FILE_MODE,
    ));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

export function createLoopAnalysisJobPaths(
  sourceRunDirectory: string,
): LoopAnalysisJobPaths {
  requireAbsolutePath(sourceRunDirectory, 'sourceRunDirectory');
  const directory = join(
    sourceRunDirectory,
    '.takt-report-internal',
    LOOP_ANALYSIS_JOB_DIRECTORY,
  );
  ensurePrivateDirectory(directory);
  const jobId = randomUUID();
  return {
    jobPath: join(directory, `${jobId}.job.json`),
    publicationMarkerPath: join(directory, `${jobId}.publication.json`),
  };
}

export function writeLoopAnalysisJob(jobPath: string, job: LoopAnalysisJob): void {
  requireAbsolutePath(jobPath, 'jobPath');
  validateLoopAnalysisJob(job);
  writeNewPrivateFileWithMode(
    jobPath,
    `${JSON.stringify(job)}\n`,
    PRIVATE_FILE_MODE,
  );
}

export function readLoopAnalysisJob(jobPath: string): LoopAnalysisJob {
  requireAbsolutePath(jobPath, 'jobPath');
  const snapshot = readPrivateFileState(jobPath);
  if (!('content' in snapshot)) {
    throw new Error(`Loop analysis job does not exist: ${jobPath}`);
  }
  const parsed: unknown = JSON.parse(snapshot.content.toString('utf8'));
  return validateLoopAnalysisJob(parsed);
}

export function writeLoopAnalysisPublicationMarker(
  markerPath: string,
  state: LoopAnalysisPublicationState,
): void {
  requireAbsolutePath(markerPath, 'publicationMarkerPath');
  const marker: LoopAnalysisPublicationMarker = {
    version: LOOP_ANALYSIS_JOB_VERSION,
    state,
  };
  writePrivateFile(markerPath, `${JSON.stringify(marker)}\n`);
}

export function readLoopAnalysisPublicationMarker(
  markerPath: string,
): LoopAnalysisPublicationState {
  requireAbsolutePath(markerPath, 'publicationMarkerPath');
  const snapshot = readPrivateFileState(markerPath);
  if (!('content' in snapshot)) {
    throw new Error(`Loop analysis publication marker does not exist: ${markerPath}`);
  }
  const parsed: unknown = JSON.parse(snapshot.content.toString('utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Loop analysis publication marker must be an object');
  }
  requireExactKeys(parsed, ['state', 'version'], 'Loop analysis publication marker');
  if (parsed.version !== LOOP_ANALYSIS_JOB_VERSION) {
    throw new Error('Unsupported loop analysis publication marker version');
  }
  if (parsed.state !== 'pending' && parsed.state !== 'settled') {
    throw new Error('Invalid loop analysis publication marker state');
  }
  return parsed.state;
}

export function appendLoopAnalysisWorkerFailure(
  jobPath: string,
  error: unknown,
): void {
  requireAbsolutePath(jobPath, 'jobPath');
  const entry = {
    timestamp: new Date().toISOString(),
    error: getErrorMessage(error),
  };
  appendPrivateFile(
    join(dirname(jobPath), LOOP_ANALYSIS_WORKER_FAILURE_LOG),
    `${JSON.stringify(entry)}\n`,
  );
}

function validateLoopAnalysisJob(value: unknown): LoopAnalysisJob {
  if (!isRecord(value)) {
    throw new Error('Loop analysis job must be an object');
  }
  const hasPublication = value.branch !== undefined
    || value.publicationMarkerPath !== undefined;
  requireExactKeys(
    value,
    hasPublication
      ? [
          'branch',
          'output',
          'parentPid',
          'projectCwd',
          'publicationMarkerPath',
          'sourceRunDirectory',
          'version',
        ]
      : [
          'output',
          'parentPid',
          'projectCwd',
          'sourceRunDirectory',
          'version',
        ],
    'Loop analysis job',
  );
  if (value.version !== LOOP_ANALYSIS_JOB_VERSION) {
    throw new Error('Unsupported loop analysis job version');
  }
  const projectCwd = requireAbsoluteString(value.projectCwd, 'projectCwd');
  const sourceRunDirectory = requireAbsoluteString(
    value.sourceRunDirectory,
    'sourceRunDirectory',
  );
  if (value.output !== 'file' && value.output !== 'pr-comment') {
    throw new Error('Invalid loop analysis output');
  }
  if (!Number.isSafeInteger(value.parentPid) || Number(value.parentPid) <= 0) {
    throw new Error('Loop analysis parentPid must be a positive integer');
  }
  if (!hasPublication) {
    return {
      version: LOOP_ANALYSIS_JOB_VERSION,
      projectCwd,
      sourceRunDirectory,
      output: value.output,
      parentPid: Number(value.parentPid),
    };
  }
  if (value.output !== 'pr-comment') {
    throw new Error('Loop analysis publication metadata requires pr-comment output');
  }
  const branch = requireNonEmptyString(value.branch, 'branch');
  const publicationMarkerPath = requireAbsoluteString(
    value.publicationMarkerPath,
    'publicationMarkerPath',
  );
  return {
    version: LOOP_ANALYSIS_JOB_VERSION,
    projectCwd,
    sourceRunDirectory,
    output: value.output,
    parentPid: Number(value.parentPid),
    branch,
    publicationMarkerPath,
  };
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length
    || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function requireAbsoluteString(value: unknown, fieldName: string): string {
  const text = requireNonEmptyString(value, fieldName);
  requireAbsolutePath(text, fieldName);
  return text;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Loop analysis ${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireAbsolutePath(value: string, fieldName: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`Loop analysis ${fieldName} must be an absolute path`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
