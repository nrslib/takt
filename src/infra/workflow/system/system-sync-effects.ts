import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { runSyncConflictResolver } from '../../service/runSyncConflictResolver.js';
import {
  abortMerge,
  fastForwardPrBranch,
  fetchRemoteBranch,
  isMergeInProgressError,
  mergeBaseBranch,
  pushSynced,
  requirePrBranchTarget,
} from './system-effect-git-helpers.js';
import {
  appendSecondaryError,
  fetchPrContext,
  getCommandErrorDetail,
  isMergeConflictError,
} from './system-git-context.js';

function updatePrHeadBranch(cwd: string, headRefName: string): void {
  requirePrBranchTarget(cwd, headRefName);
  fetchRemoteBranch(cwd, headRefName);
  fastForwardPrBranch(cwd, headRefName);
}

export function syncWithRootEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Record<string, unknown> {
  const pr = fetchPrContext(options.projectCwd, payload.pr);
  if (!pr.baseRefName) {
    return { success: false, failed: true, conflicted: false, error: 'PR base branch is not available' };
  }

  try {
    updatePrHeadBranch(options.cwd, pr.headRefName);
    fetchRemoteBranch(options.cwd, pr.baseRefName);
    mergeBaseBranch(options.cwd, pr.baseRefName);
  } catch (error) {
    const detail = getCommandErrorDetail(error);
    if (isMergeConflictError(error)) {
      const abortError = abortMerge(options.cwd);
      if (abortError) {
        return {
          success: false,
          failed: true,
          conflicted: false,
          error: appendSecondaryError(detail, 'merge abort failed', abortError),
        };
      }
      return { success: false, failed: false, conflicted: true, error: detail };
    }
    return { success: false, failed: true, conflicted: false, error: detail };
  }

  try {
    pushSynced(options.cwd, options.projectCwd, pr.headRefName);
    return { success: true, failed: false, conflicted: false };
  } catch (error) {
    return { success: false, failed: true, conflicted: false, error: String(error) };
  }
}

export async function resolveConflictsWithAiEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Promise<Record<string, unknown>> {
  const pr = fetchPrContext(options.projectCwd, payload.pr);
  if (!pr.baseRefName) {
    return { success: false, failed: true, conflicted: false, error: 'PR base branch is not available' };
  }

  let hasConflict = false;
  let retriedAfterAbort = false;
  while (true) {
    try {
      updatePrHeadBranch(options.cwd, pr.headRefName);
      fetchRemoteBranch(options.cwd, pr.baseRefName);
      mergeBaseBranch(options.cwd, pr.baseRefName);
      break;
    } catch (error) {
      if (isMergeConflictError(error)) {
        hasConflict = true;
        break;
      }
      if (!retriedAfterAbort && isMergeInProgressError(error)) {
        const abortError = abortMerge(options.cwd);
        if (abortError) {
          return {
            success: false,
            failed: true,
            conflicted: false,
            error: appendSecondaryError(getCommandErrorDetail(error), 'merge abort failed', abortError),
          };
        }
        retriedAfterAbort = true;
        continue;
      }
      return { success: false, failed: true, conflicted: false, error: getCommandErrorDetail(error) };
    }
  }

  if (!hasConflict) {
    try {
      pushSynced(options.cwd, options.projectCwd, pr.headRefName);
      return { success: true, failed: false, conflicted: false };
    } catch (error) {
      return { success: false, failed: true, conflicted: false, error: String(error) };
    }
  }

  const response = await runSyncConflictResolver({
    projectCwd: options.projectCwd,
    cwd: options.cwd,
    originalInstruction: options.task,
  });

  if (response.status !== 'done') {
    const abortError = abortMerge(options.cwd);
    const responseError = response.error ?? 'AI conflict resolution failed';
    return {
      success: false,
      failed: true,
      conflicted: true,
      error: abortError
        ? appendSecondaryError(responseError, 'merge abort failed', abortError)
        : responseError,
    };
  }

  try {
    pushSynced(options.cwd, options.projectCwd, pr.headRefName);
  } catch (error) {
    return { success: false, failed: true, conflicted: true, error: String(error) };
  }

  return { success: true, failed: false, conflicted: false };
}
