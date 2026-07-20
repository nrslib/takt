import {
  createIssueAndEnqueueTask,
  type IssueEnqueueFailure,
} from '../../task/enqueueService.js';
import type {
  WorkflowEnqueueBaseBranchConfig,
  WorkflowEnqueueIssueConfig,
  WorkflowEnqueueWorktreeConfig,
} from '../../../core/models/types.js';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { getGitProvider } from '../../git/index.js';
import { createBaseBranchIfMissing, resolveBaseBranch } from '../../task/index.js';
import { saveEnqueuedTaskFile } from '../../task/enqueuedTaskFile.js';
import { createIssueFromTaskResult } from '../../task/issueTask.js';
import { fetchPrContext } from './system-git-context.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import type { CloseIssueResult } from '../../git/index.js';
import { existsSync } from 'node:fs';
import { ActiveTaskTargetConflictError, findActiveTaskTargetConflict } from '../../task/activeTaskTarget.js';
import { TaskStore } from '../../task/store.js';

function filterIssueLabels(issue: WorkflowEnqueueIssueConfig): string[] | undefined {
  const labels = issue.labels?.filter((label) => label.trim().length > 0);
  return labels && labels.length > 0 ? labels : undefined;
}

function resolveValidatedBaseBranch(
  projectCwd: string,
  baseBranch?: string | WorkflowEnqueueBaseBranchConfig,
): string | undefined {
  if (baseBranch === undefined) {
    return undefined;
  }
  if (typeof baseBranch !== 'string') {
    return createBaseBranchIfMissing(projectCwd, baseBranch).branch;
  }
  return resolveBaseBranch(projectCwd, baseBranch).branch;
}

function sanitizeCloseIssueResult(result: CloseIssueResult): CloseIssueResult {
  if (result.success) {
    return result;
  }
  return {
    ...result,
    error: safeExternalErrorMessage(result.error),
  };
}

function buildIssueEnqueueFailureResult(failure: IssueEnqueueFailure): Record<string, unknown> {
  if (failure.stage === 'issue_creation') {
    return {
      success: false,
      failed: true,
      stage: failure.stage,
      error: safeExternalErrorMessage(failure.error),
    };
  }
  return {
    success: false,
    failed: true,
    stage: failure.stage,
    issueNumber: failure.issueNumber,
    error: safeExternalErrorMessage(failure.error),
    compensation: sanitizeCloseIssueResult(failure.compensation),
  };
}

function buildDuplicateEnqueueResult(error: ActiveTaskTargetConflictError): Record<string, unknown> {
  return {
    success: false,
    failed: false,
    duplicate: true,
    target: error.target,
    existing_task: {
      name: error.existingTaskName,
      status: error.existingTaskStatus,
    },
  };
}

/**
 * Detect duplicates on targets known before any external processing (git
 * provider calls, base branch resolution), so a known conflict is reported as
 * `duplicate` even when those external steps would fail. The task lifecycle
 * repeats the check while holding TaskStore's process-wide file lock.
 */
function findKnownTargetConflict(
  projectCwd: string,
  payload: { mode: 'new' | 'from_pr'; pr?: number; issue_number?: number },
): ActiveTaskTargetConflictError | undefined {
  const candidate = payload.mode === 'from_pr'
    ? (payload.pr !== undefined ? { pr_number: payload.pr } : undefined)
    : (payload.issue_number !== undefined ? { issue: payload.issue_number } : undefined);
  if (candidate === undefined) {
    return undefined;
  }
  const store = new TaskStore(projectCwd);
  if (!existsSync(store.getTasksFilePath())) {
    return undefined;
  }
  return findActiveTaskTargetConflict(store.read().tasks, candidate);
}

async function createIssueBackedTask(
  options: SystemStepServicesOptions,
  payload: {
    workflow: string;
    task: string;
    issue: WorkflowEnqueueIssueConfig;
    baseBranch?: string;
    worktree?: WorkflowEnqueueWorktreeConfig;
  },
): Promise<Record<string, unknown>> {
  const labels = filterIssueLabels(payload.issue);
  const gitProvider = options.gitProvider ?? getGitProvider();
  const result = await createIssueAndEnqueueTask({
    cwd: options.projectCwd,
    task: payload.task,
    workflow: payload.workflow,
    ...(labels !== undefined ? { labels } : {}),
    ...(payload.issue.title !== undefined ? { title: payload.issue.title } : {}),
    gitProvider,
    issueOutputMode: 'silent',
    ...(payload.worktree?.enabled === true ? { worktree: true } : {}),
    ...(payload.worktree?.auto_pr === true ? { autoPr: true } : {}),
    ...(payload.worktree?.draft_pr !== undefined ? { draftPr: payload.worktree.draft_pr } : {}),
    ...(payload.worktree?.managed_pr === true ? { managedPr: true } : {}),
    ...(payload.baseBranch !== undefined ? { taskContext: { baseBranch: payload.baseBranch } } : {}),
  }, {
    saveTaskFile: saveEnqueuedTaskFile,
    createIssueFromTaskResult,
  });
  if (!result.success) {
    return buildIssueEnqueueFailureResult(result.failure);
  }
  return {
    success: true,
    failed: false,
    taskName: result.created.taskName,
    tasksFile: result.created.tasksFile,
    ...(result.created.issueNumber !== undefined ? { issueNumber: result.created.issueNumber } : {}),
  };
}

export async function enqueueTaskEffect(
  options: SystemStepServicesOptions,
  payload: {
    mode: 'new' | 'from_pr';
    workflow: string;
    task: string;
    pr?: number;
    issue_number?: number;
    issue?: WorkflowEnqueueIssueConfig;
    base_branch?: string | WorkflowEnqueueBaseBranchConfig;
    worktree?: WorkflowEnqueueWorktreeConfig;
  },
): Promise<Record<string, unknown>> {
  const knownConflict = findKnownTargetConflict(options.projectCwd, payload);
  if (knownConflict) {
    return buildDuplicateEnqueueResult(knownConflict);
  }

  const baseBranch = resolveValidatedBaseBranch(options.projectCwd, payload.base_branch);

  try {
    if (payload.mode === 'new') {
      if (payload.issue?.create === true) {
        return createIssueBackedTask(options, {
          workflow: payload.workflow,
          task: payload.task,
          issue: payload.issue,
          ...(baseBranch !== undefined ? { baseBranch } : {}),
          ...(payload.worktree !== undefined ? { worktree: payload.worktree } : {}),
        });
      }
      const created = await saveEnqueuedTaskFile(options.projectCwd, payload.task, {
        workflow: payload.workflow,
        ...(payload.issue_number !== undefined ? { issue: payload.issue_number } : {}),
        ...(payload.worktree?.enabled === true ? { worktree: true } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(payload.worktree?.auto_pr === true ? { autoPr: true } : {}),
        ...(payload.worktree?.draft_pr !== undefined ? { draftPr: payload.worktree.draft_pr } : {}),
        ...(payload.worktree?.managed_pr === true ? { managedPr: true } : {}),
      });
      return { success: true, failed: false, ...created };
    }

    if (payload.pr == null || !Number.isSafeInteger(payload.pr) || payload.pr <= 0) {
      throw new Error('System effect requires positive safe integer field "pr"');
    }

    const pr = fetchPrContext(options.projectCwd, payload.pr, options.gitProvider);
    const requestedBaseBranch = baseBranch ?? pr.baseRefName;
    if (!requestedBaseBranch) {
      return { success: false, failed: true, error: 'PR base branch is not available' };
    }
    const prBaseBranch = baseBranch ?? resolveBaseBranch(options.projectCwd, requestedBaseBranch).branch;
    const created = await saveEnqueuedTaskFile(options.projectCwd, payload.task, {
      workflow: payload.workflow,
      worktree: true,
      branch: pr.headRefName,
      baseBranch: prBaseBranch,
      autoPr: false,
      shouldPublishBranchToOrigin: true,
      prNumber: payload.pr,
    });
    return { success: true, failed: false, ...created, prNumber: payload.pr };
  } catch (error) {
    if (error instanceof ActiveTaskTargetConflictError) {
      return buildDuplicateEnqueueResult(error);
    }
    throw error;
  }
}
