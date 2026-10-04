import {
  getCurrentBranch,
  localBranchExists,
  materializePullRequestBase,
  resolveBaseBranch,
} from '../../infra/task/index.js';
import {
  createPullRequestContext,
  type PullRequestContext,
} from '../../core/workflow/pr-context.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

interface ResolveTaskPullRequestContextOptions {
  projectDir: string;
  prNumber: number;
  headBranch: string;
  savedBaseBranch?: string;
}

interface MaterializeTaskPullRequestWorktreeContextOptions {
  projectDir: string;
  worktreePath: string;
  taskName: string;
  prContext: PullRequestContext;
}

interface ResolveTaskPullRequestWorktreeContextOptions extends ResolveTaskPullRequestContextOptions {
  worktreePath: string;
  taskName: string;
}

export function resolveTaskPullRequestContext(
  options: ResolveTaskPullRequestContextOptions,
): PullRequestContext {
  const hasSavedBaseBranch = options.savedBaseBranch !== undefined;
  const baseBranch = options.savedBaseBranch ?? resolveBaseBranch(options.projectDir).branch;
  return createPullRequestContext({
    source: 'pr_review',
    prNumber: options.prNumber,
    baseBranch,
    headBranch: options.headBranch,
    baseBranchSource: hasSavedBaseBranch ? 'pull_request' : 'default_branch_fallback',
  });
}

export function materializeTaskPullRequestWorktreeContext(
  options: MaterializeTaskPullRequestWorktreeContextOptions,
): PullRequestContext {
  const checkedOutBranch = getCurrentBranch(options.worktreePath);
  if (checkedOutBranch !== options.prContext.headBranch) {
    throw new Error(
      `PR review task "${sanitizeTerminalText(options.taskName)}" worktree is checked out on "${sanitizeTerminalText(checkedOutBranch)}", expected "${sanitizeTerminalText(options.prContext.headBranch)}".`,
    );
  }

  const headDiffRef = toLocalBranchRef(options.prContext.headBranch);
  if (!localBranchExists(options.worktreePath, options.prContext.headBranch)) {
    throw new Error(
      `PR review task "${sanitizeTerminalText(options.taskName)}" worktree is missing head ref ${headDiffRef}.`,
    );
  }

  return createPullRequestContext({
    ...options.prContext,
    baseDiffRef: materializePullRequestBase(
      options.projectDir,
      options.worktreePath,
      options.prContext.baseBranch,
    ),
    headDiffRef,
  });
}

export function resolveTaskPullRequestWorktreeContext(
  options: ResolveTaskPullRequestWorktreeContextOptions,
): PullRequestContext {
  const prContext = resolveTaskPullRequestContext(options);
  return materializeTaskPullRequestWorktreeContext({
    projectDir: options.projectDir,
    worktreePath: options.worktreePath,
    taskName: options.taskName,
    prContext,
  });
}
