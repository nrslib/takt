import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInside, isValidReportDirName } from '../../../shared/utils/index.js';

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
}

export function readRunMeta(metaPath: string): RunMeta | null {
  if (!existsSync(metaPath)) {
    return null;
  }

  const raw = readFileSync(metaPath, 'utf-8').trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

export function readRunMetaBySlug(cwd: string, slug: string): RunMeta | null {
  if (!isValidReportDirName(slug)) {
    return null;
  }

  const runsDir = resolve(cwd, '.takt', 'runs');
  const metaPath = resolve(runsDir, slug, 'meta.json');
  if (!isPathInside(runsDir, metaPath)) {
    return null;
  }

  return readRunMeta(metaPath);
}

function resolveRunningStep(meta: RunMeta | null): string | undefined {
  if (!meta) {
    return undefined;
  }

  if (meta.status !== 'running' || !meta.currentStep) {
    return undefined;
  }

  return meta.currentStep;
}

export function findRunningStepByRunSlug(cwd: string, runSlug: string): string | undefined {
  return resolveRunningStep(readRunMetaBySlug(cwd, runSlug));
}
