import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInside, isValidReportDirName } from '../../../shared/utils/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import type { WorkflowResumePoint } from '../../models/types.js';
import { buildRunPaths } from './run-paths.js';

export interface RunMeta {
  task: string;
  workflow: string;
  runSlug: string;
  runRoot: string;
  reportDirectory: string;
  contextDirectory: string;
  logsDirectory: string;
  status: 'running' | 'completed' | 'aborted';
  startTime: string;
  endTime?: string;
  iterations?: number;
  currentStep?: string;
  currentIteration?: number;
  phase?: 1 | 2 | 3;
  updatedAt?: string;
  resumePoint?: WorkflowResumePoint;
}

interface RawRunMeta extends RunMeta {
  resume_point?: WorkflowResumePoint;
}

export type RunMetaWarningHandler = (warning: string) => void;

function normalizeRunMeta(raw: RawRunMeta): RunMeta {
  return {
    ...raw,
    resumePoint: raw.resumePoint ?? raw.resume_point,
  };
}

function emitRunMetaWarning(
  metaPath: string,
  error: unknown,
  onWarning?: RunMetaWarningHandler,
): null {
  onWarning?.(`Failed to parse run metadata at ${metaPath}: ${getErrorMessage(error)}`);
  return null;
}

export function readRunMeta(metaPath: string, onWarning?: RunMetaWarningHandler): RunMeta | null {
  if (!existsSync(metaPath)) {
    return null;
  }

  const raw = readFileSync(metaPath, 'utf-8').trim();
  if (!raw) {
    return null;
  }

  try {
    return normalizeRunMeta(JSON.parse(raw) as RawRunMeta);
  } catch (error) {
    return emitRunMetaWarning(metaPath, error, onWarning);
  }
}

export function readRunMetaBySlug(cwd: string, slug: string, onWarning?: RunMetaWarningHandler): RunMeta | null {
  if (!isValidReportDirName(slug)) {
    return null;
  }

  const runsDir = resolve(cwd, '.takt', 'runs');
  const metaPath = resolve(runsDir, slug, 'meta.json');
  if (!isPathInside(runsDir, metaPath)) {
    return null;
  }

  const meta = readRunMeta(metaPath, onWarning);
  if (!meta) {
    return null;
  }

  const runPaths = buildRunPaths(cwd, slug);
  return {
    ...meta,
    runSlug: slug,
    runRoot: runPaths.runRootRel,
    reportDirectory: runPaths.reportsRel,
    contextDirectory: runPaths.contextRel,
    logsDirectory: runPaths.logsRel,
  };
}

function resolveRunningStep(meta: RunMeta | null): string | undefined {
  if (!meta) {
    return undefined;
  }

  if (meta.status !== 'running') {
    return undefined;
  }

  if (meta.currentStep) {
    return meta.currentStep;
  }
  return undefined;
}

export function findRunningStepByRunSlug(
  cwd: string,
  runSlug: string,
  onWarning?: RunMetaWarningHandler,
): string | undefined {
  return resolveRunningStep(readRunMetaBySlug(cwd, runSlug, onWarning));
}
