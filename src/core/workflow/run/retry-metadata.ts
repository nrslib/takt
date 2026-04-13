import type { WorkflowResumePoint } from '../../models/types.js';
import { readRunMetaBySlug, type RunMeta, type RunMetaWarningHandler } from './run-meta.js';

export interface ResolvedRetryMetadata {
  startStep?: string;
  resumePoint?: WorkflowResumePoint;
  currentIteration?: number;
  preserveExisting?: boolean;
}

export function resolveRetryMetadataFromRunMeta(runMeta: RunMeta | null): ResolvedRetryMetadata {
  if (!runMeta) {
    return {};
  }

  const resumePoint = runMeta.resumePoint;
  const rootStep = resumePoint?.stack[0]?.step ?? runMeta.currentStep;
  const currentIteration = resumePoint?.iteration ?? runMeta.currentIteration;

  return {
    ...(rootStep ? { startStep: rootStep } : {}),
    ...(resumePoint ? { resumePoint } : {}),
    ...(currentIteration !== undefined ? { currentIteration } : {}),
  };
}

export function readRetryMetadataByRunSlug(
  cwd: string,
  runSlug: string,
  onWarning?: RunMetaWarningHandler,
): ResolvedRetryMetadata {
  let parseFailed = false;
  const runMeta = readRunMetaBySlug(cwd, runSlug, (warning) => {
    parseFailed = true;
    onWarning?.(warning);
  });

  if (!runMeta) {
    return parseFailed ? { preserveExisting: true } : {};
  }

  return resolveRetryMetadataFromRunMeta(runMeta);
}
