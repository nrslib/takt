import { execFileSync } from 'node:child_process';
import { formatIssueAsTask, buildPrBody, formatPrReviewAsTask } from '../../infra/github/index.js';
import { getGitProvider, type Issue } from '../../infra/git/index.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { stageAndCommit, resolveBaseBranch, pushBranch, checkoutBranch } from '../../infra/task/index.js';
import { executeTask, confirmAndCreateWorktree, type TaskExecutionOptions, type PipelineExecutionOptions } from '../tasks/index.js';
import { info, error, success } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { PipelineConfig } from '../../core/models/index.js';

export interface TaskContent {
  task: string;
  issue?: Issue;
  prBranch?: string;
  prBaseBranch?: string;
}

export interface GitExecutionContext {
  execCwd: string;
  isWorktree: boolean;
  branch: string;
  baseBranch: string;
}

export interface SkipGitExecutionContext {
  execCwd: string;
  isWorktree: false;
  branch: undefined;
  baseBranch: undefined;
}

export type ExecutionContext = GitExecutionContext | SkipGitExecutionContext;

function requireBaseBranch(baseBranch: string | undefined, context: string): string {
  if (!baseBranch) {
    throw new Error(`Base branch is required (${context})`);
  }
  return baseBranch;
}

function requireBranch(branch: string | undefined, context: string): string {
  if (!branch) {
    throw new Error(`Branch is required (${context})`);
  }
  return branch;
}

function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

function generatePipelineBranchName(pipelineConfig: PipelineConfig | undefined, issueNumber?: number): string {
  const prefix = pipelineConfig?.defaultBranchPrefix ?? 'takt/';
  const timestamp = Math.floor(Date.now() / 1000);
  return issueNumber
    ? `${prefix}issue-${issueNumber}-${timestamp}`
    : `${prefix}pipeline-${timestamp}`;
}

export function buildCommitMessage(
  pipelineConfig: PipelineConfig | undefined,
  issue: Issue | undefined,
  taskText: string | undefined,
): string {
  const template = pipelineConfig?.commitMessageTemplate;
  if (template && issue) {
    return expandTemplate(template, {
      title: issue.title,
      issue: String(issue.number),
    });
  }
  return issue
    ? `feat: ${issue.title} (#${issue.number})`
    : `takt: ${taskText ?? 'pipeline task'}`;
}

function resolveExecutionBaseBranch(cwd: string, preferredBaseBranch?: string): string {
  const { branch } = resolveBaseBranch(cwd, preferredBaseBranch);
  return requireBaseBranch(branch, 'execution context');
}

function buildPipelinePrBody(
  pipelineConfig: PipelineConfig | undefined,
  issue: Issue | undefined,
  report: string,
): string {
  const template = pipelineConfig?.prBodyTemplate;
  if (template && issue) {
    return expandTemplate(template, {
      title: issue.title,
      issue: String(issue.number),
      issue_body: issue.body || issue.title,
      report,
    });
  }
  return buildPrBody(issue ? [issue] : undefined, report);
}

function fetchGitHubResource<T>(
  label: string,
  fetch: (provider: ReturnType<typeof getGitProvider>) => T,
): T | undefined {
  const gitProvider = getGitProvider();
  const cliStatus = gitProvider.checkCliStatus();
  if (!cliStatus.available) {
    error(cliStatus.error ?? 'gh CLI is not available');
    return undefined;
  }
  try {
    return fetch(gitProvider);
  } catch (err) {
    error(`Failed to fetch ${label}: ${getErrorMessage(err)}`);
    return undefined;
  }
}

export function resolveTaskContent(options: PipelineExecutionOptions): TaskContent | undefined {
  if (options.prNumber) {
    info(`Fetching PR #${options.prNumber} review comments...`);
    const prReview = fetchGitHubResource(
      `PR #${options.prNumber}`,
      (provider) => provider.fetchPrReviewComments(options.prNumber!),
    );
    if (!prReview) return undefined;
    const task = formatPrReviewAsTask(prReview);
    success(`PR #${options.prNumber} fetched: "${prReview.title}"`);
    return {
      task,
      prBranch: prReview.headRefName,
      prBaseBranch: prReview.baseRefName,
    };
  }
  if (options.issueNumber) {
    info(`Fetching issue #${options.issueNumber}...`);
    const issue = fetchGitHubResource(
      `issue #${options.issueNumber}`,
      (provider) => provider.fetchIssue(options.issueNumber!),
    );
    if (!issue) return undefined;
    const task = formatIssueAsTask(issue);
    success(`Issue #${options.issueNumber} fetched: "${issue.title}"`);
    return { task, issue };
  }
  if (options.task) {
    return { task: options.task };
  }
  error('Either --issue, --pr, or --task must be specified');
  return undefined;
}

export async function resolveExecutionContext(
  cwd: string,
  task: string,
  options: Pick<PipelineExecutionOptions, 'createWorktree' | 'skipGit' | 'branch' | 'issueNumber'>,
  pipelineConfig: PipelineConfig | undefined,
  prBranch?: string,
  prBaseBranch?: string,
): Promise<ExecutionContext> {
  if (options.createWorktree) {
    const result = await confirmAndCreateWorktree(cwd, task, options.createWorktree, prBranch, prBaseBranch);
    const branch = requireBranch(result.branch, 'worktree execution');
    const baseBranch = requireBaseBranch(result.baseBranch, 'worktree execution');
    if (result.isWorktree) {
      success(`Worktree created: ${result.execCwd}`);
    }
    return {
      execCwd: result.execCwd,
      branch,
      baseBranch,
      isWorktree: result.isWorktree,
    };
  }
  if (options.skipGit) {
    return {
      execCwd: cwd,
      isWorktree: false,
      branch: undefined,
      baseBranch: undefined,
    };
  }
  if (prBranch) {
    info(`Fetching and checking out PR branch: ${prBranch}`);
    checkoutBranch(cwd, prBranch);
    success(`Checked out PR branch: ${prBranch}`);
    const baseBranch = resolveExecutionBaseBranch(cwd, prBaseBranch);
    return {
      execCwd: cwd,
      branch: prBranch,
      baseBranch,
      isWorktree: false,
    };
  }
  const baseBranch = resolveExecutionBaseBranch(cwd);
  const branch = options.branch ?? generatePipelineBranchName(pipelineConfig, options.issueNumber);
  info(`Creating branch: ${branch}`);
  execFileSync('git', ['checkout', '-b', branch], { cwd, stdio: 'pipe' });
  success(`Branch created: ${branch}`);
  return { execCwd: cwd, branch, baseBranch, isWorktree: false };
}

export async function runPiece(
  projectCwd: string,
  piece: string,
  task: string,
  execCwd: string,
  options: Pick<PipelineExecutionOptions, 'provider' | 'model'>,
): Promise<boolean> {
  info(`Running piece: ${piece}`);
  const agentOverrides: TaskExecutionOptions | undefined = (options.provider || options.model)
    ? { provider: options.provider, model: options.model }
    : undefined;

  const taskSuccess = await executeTask({
    task,
    cwd: execCwd,
    pieceIdentifier: piece,
    projectCwd,
    agentOverrides,
  });

  if (!taskSuccess) {
    error(`Piece '${piece}' failed`);
    return false;
  }
  success(`Piece '${piece}' completed`);
  return true;
}

export function commitAndPush(
  execCwd: string,
  projectCwd: string,
  branch: string,
  commitMessage: string,
  isWorktree: boolean,
): boolean {
  info('Committing changes...');
  try {
    const commitHash = stageAndCommit(execCwd, commitMessage, {
      allowGitHooks: resolveConfigValue(projectCwd, 'allowGitHooks') ?? false,
      allowGitFilters: resolveConfigValue(projectCwd, 'allowGitFilters') ?? false,
    });
    if (commitHash) {
      success(`Changes committed: ${commitHash}`);
    } else {
      info('No changes to commit');
    }

    if (isWorktree) {
      execFileSync('git', ['push', projectCwd, 'HEAD'], { cwd: execCwd, stdio: 'pipe' });
    }

    info(`Pushing to origin/${branch}...`);
    pushBranch(projectCwd, branch);
    success(`Pushed to origin/${branch}`);
    return true;
  } catch (err) {
    error(`Git operation failed: ${getErrorMessage(err)}`);
    return false;
  }
}

export function submitPullRequest(
  projectCwd: string,
  branch: string,
  baseBranch: string,
  taskContent: TaskContent,
  piece: string,
  pipelineConfig: PipelineConfig | undefined,
  options: Pick<PipelineExecutionOptions, 'task' | 'repo' | 'draftPr'>,
): string | undefined {
  info('Creating pull request...');
  const resolvedBaseBranch = requireBaseBranch(baseBranch, 'pull request creation');
  const prTitle = taskContent.issue ? `[#${taskContent.issue.number}] ${taskContent.issue.title}` : (options.task ?? 'Pipeline task');
  const report = `Piece \`${piece}\` completed successfully.`;
  const prBody = buildPipelinePrBody(pipelineConfig, taskContent.issue, report);

  const prResult = getGitProvider().createPullRequest(projectCwd, {
    branch,
    title: prTitle,
    body: prBody,
    base: resolvedBaseBranch,
    repo: options.repo,
    draft: options.draftPr,
  });

  if (prResult.success) {
    success(`PR created: ${prResult.url}`);
    return prResult.url;
  }
  error(`PR creation failed: ${prResult.error}`);
  return undefined;
}
