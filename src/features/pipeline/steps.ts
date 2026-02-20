/**
 * Pipeline step implementations
 *
 * Each function encapsulates one step of the pipeline,
 * keeping the orchestrator at a consistent abstraction level.
 */

import { execFileSync } from 'node:child_process';
import {
  fetchIssue,
  formatIssueAsTask,
  checkGhCli,
  createPullRequest,
  pushBranch,
  buildPrBody,
  type GitHubIssue,
} from '../../infra/github/index.js';
import { stageAndCommit, resolveBaseBranch } from '../../infra/task/index.js';
import { executeTask, confirmAndCreateWorktree, type TaskExecutionOptions, type PipelineExecutionOptions } from '../tasks/index.js';
import { info, error, success } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { PipelineConfig } from '../../core/models/index.js';

// ---- Types ----

export interface TaskContent {
  task: string;
  issue?: GitHubIssue;
}

export interface ExecutionContext {
  execCwd: string;
  branch?: string;
  baseBranch?: string;
  isWorktree: boolean;
}

// ---- Template helpers ----

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
  issue: GitHubIssue | undefined,
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

function buildPipelinePrBody(
  pipelineConfig: PipelineConfig | undefined,
  issue: GitHubIssue | undefined,
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

// ---- Step 1: Resolve task content ----

export function resolveTaskContent(options: PipelineExecutionOptions): TaskContent | undefined {
  if (options.issueNumber) {
    info(`Fetching issue #${options.issueNumber}...`);
    const ghStatus = checkGhCli();
    if (!ghStatus.available) {
      error(ghStatus.error ?? 'gh CLI is not available');
      return undefined;
    }
    try {
      const issue = fetchIssue(options.issueNumber);
      const task = formatIssueAsTask(issue);
      success(`Issue #${options.issueNumber} fetched: "${issue.title}"`);
      return { task, issue };
    } catch (err) {
      error(`Failed to fetch issue #${options.issueNumber}: ${getErrorMessage(err)}`);
      return undefined;
    }
  }
  if (options.task) {
    return { task: options.task };
  }
  error('Either --issue or --task must be specified');
  return undefined;
}

// ---- Step 2: Resolve execution context ----

export async function resolveExecutionContext(
  cwd: string,
  task: string,
  options: Pick<PipelineExecutionOptions, 'createWorktree' | 'skipGit' | 'branch' | 'issueNumber'>,
  pipelineConfig: PipelineConfig | undefined,
): Promise<ExecutionContext> {
  if (options.createWorktree) {
    const result = await confirmAndCreateWorktree(cwd, task, options.createWorktree);
    if (result.isWorktree) {
      success(`Worktree created: ${result.execCwd}`);
    }
    return { execCwd: result.execCwd, branch: result.branch, baseBranch: result.baseBranch, isWorktree: result.isWorktree };
  }
  if (options.skipGit) {
    return { execCwd: cwd, isWorktree: false };
  }
  const resolved = resolveBaseBranch(cwd);
  const branch = options.branch ?? generatePipelineBranchName(pipelineConfig, options.issueNumber);
  info(`Creating branch: ${branch}`);
  execFileSync('git', ['checkout', '-b', branch], { cwd, stdio: 'pipe' });
  success(`Branch created: ${branch}`);
  return { execCwd: cwd, branch, baseBranch: resolved.branch, isWorktree: false };
}

// ---- Step 3: Run piece ----

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

// ---- Step 4: Commit & push ----

export function commitAndPush(
  execCwd: string,
  projectCwd: string,
  branch: string,
  commitMessage: string,
  isWorktree: boolean,
): boolean {
  info('Committing changes...');
  try {
    const commitHash = stageAndCommit(execCwd, commitMessage);
    if (commitHash) {
      success(`Changes committed: ${commitHash}`);
    } else {
      info('No changes to commit');
    }

    if (isWorktree) {
      // Clone has no origin — push to main project via path, then project pushes to origin
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

// ---- Step 5: Submit pull request ----

export function submitPullRequest(
  projectCwd: string,
  branch: string,
  baseBranch: string | undefined,
  taskContent: TaskContent,
  piece: string,
  pipelineConfig: PipelineConfig | undefined,
  options: Pick<PipelineExecutionOptions, 'task' | 'repo' | 'draftPr'>,
): string | undefined {
  info('Creating pull request...');
  const prTitle = taskContent.issue ? `[#${taskContent.issue.number}] ${taskContent.issue.title}` : (options.task ?? 'Pipeline task');
  const report = `Piece \`${piece}\` completed successfully.`;
  const prBody = buildPipelinePrBody(pipelineConfig, taskContent.issue, report);

  const prResult = createPullRequest(projectCwd, {
    branch,
    title: prTitle,
    body: prBody,
    base: baseBranch,
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
