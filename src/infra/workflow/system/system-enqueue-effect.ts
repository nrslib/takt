import { saveTaskFile, createIssueFromTask } from '../../../features/tasks/add/index.js';
import type {
  WorkflowEnqueueBaseBranchConfig,
  WorkflowEnqueueIssueConfig,
  WorkflowEnqueueWorktreeConfig,
} from '../../../core/models/types.js';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { createBaseBranchIfMissing, resolveBaseBranch } from '../../task/index.js';
import { fetchPrContext } from './system-git-context.js';

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

export async function enqueueTaskEffect(
  options: SystemStepServicesOptions,
  payload: {
    mode: 'new' | 'from_pr';
    workflow: string;
    task: string;
    pr?: number;
    issue?: WorkflowEnqueueIssueConfig;
    base_branch?: string | WorkflowEnqueueBaseBranchConfig;
    worktree?: WorkflowEnqueueWorktreeConfig;
  },
): Promise<Record<string, unknown>> {
  const baseBranch = resolveValidatedBaseBranch(options.projectCwd, payload.base_branch);
  let issueNumber: number | undefined;
  if (payload.issue?.create === true) {
    const issueOptions = {
      cwd: options.projectCwd,
      labels: filterIssueLabels(payload.issue),
      ...(payload.issue.title !== undefined ? { title: payload.issue.title } : {}),
    };
    issueNumber = createIssueFromTask(payload.task, issueOptions);
    if (issueNumber === undefined) {
      return { success: false, failed: true, error: 'Failed to create issue from task' };
    }
  }

  if (payload.mode === 'new') {
    const created = await saveTaskFile(options.projectCwd, payload.task, {
      workflow: payload.workflow,
      ...(issueNumber !== undefined ? { issue: issueNumber } : {}),
      ...(payload.worktree?.enabled === true ? { worktree: true } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(payload.worktree?.auto_pr === true ? { autoPr: true } : {}),
      ...(payload.worktree?.draft_pr === true ? { draftPr: true } : {}),
      ...(payload.worktree?.managed_pr === true ? { managedPr: true } : {}),
    });
    return { success: true, failed: false, ...created, ...(issueNumber !== undefined ? { issueNumber } : {}) };
  }

  if (payload.pr == null) {
    throw new Error('System effect requires positive integer field "pr"');
  }

  const pr = fetchPrContext(options.projectCwd, payload.pr);
  const requestedBaseBranch = baseBranch ?? pr.baseRefName;
  if (!requestedBaseBranch) {
    return { success: false, failed: true, error: 'PR base branch is not available' };
  }
  const prBaseBranch = baseBranch ?? resolveBaseBranch(options.projectCwd, requestedBaseBranch).branch;
  const created = await saveTaskFile(options.projectCwd, payload.task, {
    workflow: payload.workflow,
    worktree: true,
    branch: pr.headRefName,
    baseBranch: prBaseBranch,
    autoPr: false,
    shouldPublishBranchToOrigin: true,
    prNumber: payload.pr,
  });
  return { success: true, failed: false, ...created, prNumber: payload.pr };
}
