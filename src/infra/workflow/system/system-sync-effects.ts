import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { runSyncConflictResolver } from '../../service/runSyncConflictResolver.js';
import {
  abortMerge,
  fastForwardPrBranch,
  fetchRemoteBranch,
  isMergeInProgressError,
  mergeBaseBranch,
  pushSynced,
} from './system-effect-git-helpers.js';
import {
  acquirePrSyncSession,
  releasePrSyncSession,
  type PrSyncSession,
  resolvePrSyncSessionStore,
} from './system-pr-sync-worktree.js';
import {
  appendSecondaryError,
  fetchPrContext,
  getCommandErrorDetail,
  isMergeConflictError,
} from './system-git-context.js';

function updatePrHeadBranch(projectCwd: string, worktreePath: string, headRefName: string): void {
  fetchRemoteBranch(projectCwd, worktreePath, headRefName);
  fastForwardPrBranch(worktreePath, headRefName);
}

function getPrSyncSession(
  prSyncSessionStore: Map<number, PrSyncSession>,
  projectCwd: string,
  prNumber: number,
  headRefName: string,
): PrSyncSession {
  return acquirePrSyncSession(prSyncSessionStore, projectCwd, prNumber, headRefName);
}

export async function syncWithRootEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Promise<Record<string, unknown>> {
  const pr = fetchPrContext(options.projectCwd, payload.pr);
  const baseRefName = pr.baseRefName;
  if (!baseRefName) {
    return { success: false, failed: true, conflicted: false, error: 'PR base branch is not available' };
  }

  const prSyncSessionStore = resolvePrSyncSessionStore(options.runtimeState);
  let retainSession = false;
  try {
    const session = getPrSyncSession(prSyncSessionStore, options.projectCwd, payload.pr, pr.headRefName);
    const worktreePath = session.worktreePath;

    try {
      updatePrHeadBranch(options.projectCwd, worktreePath, pr.headRefName);
      fetchRemoteBranch(options.projectCwd, worktreePath, baseRefName);
      mergeBaseBranch(worktreePath, baseRefName);
    } catch (error) {
      const detail = getCommandErrorDetail(error);
      if (isMergeConflictError(error)) {
        const abortError = abortMerge(worktreePath);
        if (abortError) {
          return {
            success: false,
            failed: true,
            conflicted: false,
            error: appendSecondaryError(detail, 'merge abort failed', abortError),
          };
        }
        retainSession = options.runtimeState !== undefined;
        return { success: false, failed: false, conflicted: true, error: detail };
      }
      return { success: false, failed: true, conflicted: false, error: detail };
    }

    try {
      pushSynced(worktreePath, options.projectCwd, pr.headRefName);
      return { success: true, failed: false, conflicted: false };
    } catch (error) {
      return { success: false, failed: true, conflicted: false, error: String(error) };
    }
  } catch (error) {
    return { success: false, failed: true, conflicted: false, error: getCommandErrorDetail(error) };
  } finally {
    if (!retainSession) {
      releasePrSyncSession(prSyncSessionStore, payload.pr);
    }
  }
}

export async function resolveConflictsWithAiEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Promise<Record<string, unknown>> {
  const pr = fetchPrContext(options.projectCwd, payload.pr);
  const baseRefName = pr.baseRefName;
  if (!baseRefName) {
    return { success: false, failed: true, conflicted: false, error: 'PR base branch is not available' };
  }

  const prSyncSessionStore = resolvePrSyncSessionStore(options.runtimeState);
  try {
    const session = getPrSyncSession(prSyncSessionStore, options.projectCwd, payload.pr, pr.headRefName);
    const worktreePath = session.worktreePath;

    let hasConflict = false;
    let retriedAfterAbort = false;
    while (true) {
      try {
        updatePrHeadBranch(options.projectCwd, worktreePath, pr.headRefName);
        fetchRemoteBranch(options.projectCwd, worktreePath, baseRefName);
        mergeBaseBranch(worktreePath, baseRefName);
        break;
      } catch (error) {
        if (isMergeConflictError(error)) {
          hasConflict = true;
          break;
        }
        if (!retriedAfterAbort && isMergeInProgressError(error)) {
          const abortError = abortMerge(worktreePath);
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
        pushSynced(worktreePath, options.projectCwd, pr.headRefName);
        return { success: true, failed: false, conflicted: false };
      } catch (error) {
        return { success: false, failed: true, conflicted: false, error: String(error) };
      }
    }

    const response = await runSyncConflictResolver({
      projectCwd: options.projectCwd,
      cwd: worktreePath,
      originalInstruction: options.task,
    });

    if (response.status !== 'done') {
      const abortError = abortMerge(worktreePath);
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
      pushSynced(worktreePath, options.projectCwd, pr.headRefName);
    } catch (error) {
      return { success: false, failed: true, conflicted: true, error: String(error) };
    }

    return { success: true, failed: false, conflicted: false };
  } catch (error) {
    return { success: false, failed: true, conflicted: false, error: getCommandErrorDetail(error) };
  } finally {
    releasePrSyncSession(prSyncSessionStore, payload.pr);
  }
}
