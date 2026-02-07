/**
 * Pipeline execution flow
 *
 * Orchestrates the full pipeline:
 *   1. Fetch issue content
 *   2. Create branch
 *   3. Run piece
 *   4. Commit & push
 *   5. Create PR
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
import { stageAndCommit, getCurrentBranch } from '../../infra/task/index.js';
import { executeTask, type TaskExecutionOptions, type PipelineExecutionOptions } from '../tasks/index.js';
import { loadGlobalConfig } from '../../infra/config/index.js';
import { info, error, success, status, blankLine } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { PipelineConfig } from '../../core/models/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_PIECE_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../../shared/exitCodes.js';

export type { PipelineExecutionOptions };

const log = createLogger('pipeline');

/**
 * Expand template variables in a string.
 * Supported: {title}, {issue}, {issue_body}, {report}
 */
function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/** Generate a branch name for pipeline execution */
function generatePipelineBranchName(pipelineConfig: PipelineConfig | undefined, issueNumber?: number): string {
  const prefix = pipelineConfig?.defaultBranchPrefix ?? 'takt/';
  const timestamp = Math.floor(Date.now() / 1000);
  if (issueNumber) {
    return `${prefix}issue-${issueNumber}-${timestamp}`;
  }
  return `${prefix}pipeline-${timestamp}`;
}

/** Create and checkout a new branch */
function createBranch(cwd: string, branch: string): void {
  execFileSync('git', ['checkout', '-b', branch], {
    cwd,
    stdio: 'pipe',
  });
}

/** Build commit message from template or defaults */
function buildCommitMessage(
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
  // Default commit message
  return issue
    ? `feat: ${issue.title} (#${issue.number})`
    : `takt: ${taskText ?? 'pipeline task'}`;
}

/** Build PR body from template or defaults */
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

/**
 * Execute the full pipeline.
 *
 * Returns a process exit code (0 on success, 2-5 on specific failures).
 */
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const { cwd, piece, autoPr, skipGit } = options;
  const globalConfig = loadGlobalConfig();
  const pipelineConfig = globalConfig.pipeline;
  let issue: GitHubIssue | undefined;
  let task: string;

  // --- Step 1: Resolve task content ---
  if (options.issueNumber) {
    info(`Fetching issue #${options.issueNumber}...`);
    try {
      const ghStatus = checkGhCli();
      if (!ghStatus.available) {
        error(ghStatus.error ?? 'gh CLI is not available');
        return EXIT_ISSUE_FETCH_FAILED;
      }
      issue = fetchIssue(options.issueNumber);
      task = formatIssueAsTask(issue);
      success(`Issue #${options.issueNumber} fetched: "${issue.title}"`);
    } catch (err) {
      error(`Failed to fetch issue #${options.issueNumber}: ${getErrorMessage(err)}`);
      return EXIT_ISSUE_FETCH_FAILED;
    }
  } else if (options.task) {
    task = options.task;
  } else {
    error('Either --issue or --task must be specified');
    return EXIT_ISSUE_FETCH_FAILED;
  }

  // --- Step 2: Create branch (skip if --skip-git) ---
  let branch: string | undefined;
  let baseBranch: string | undefined;
  if (!skipGit) {
    baseBranch = getCurrentBranch(cwd);
    branch = options.branch ?? generatePipelineBranchName(pipelineConfig, options.issueNumber);
    info(`Creating branch: ${branch}`);
    try {
      createBranch(cwd, branch);
      success(`Branch created: ${branch}`);
    } catch (err) {
      error(`Failed to create branch: ${getErrorMessage(err)}`);
      return EXIT_GIT_OPERATION_FAILED;
    }
  }

  // --- Step 3: Run piece ---
  info(`Running piece: ${piece}`);
  log.info('Pipeline piece execution starting', { piece, branch, skipGit, issueNumber: options.issueNumber });

  const agentOverrides: TaskExecutionOptions | undefined = (options.provider || options.model)
    ? { provider: options.provider, model: options.model }
    : undefined;

  const taskSuccess = await executeTask({
    task,
    cwd,
    pieceIdentifier: piece,
    projectCwd: cwd,
    agentOverrides,
  });

  if (!taskSuccess) {
    error(`Piece '${piece}' failed`);
    return EXIT_PIECE_FAILED;
  }
  success(`Piece '${piece}' completed`);

  // --- Step 4: Commit & push (skip if --skip-git) ---
  if (!skipGit && branch) {
    const commitMessage = buildCommitMessage(pipelineConfig, issue, options.task);

    info('Committing changes...');
    try {
      const commitHash = stageAndCommit(cwd, commitMessage);
      if (commitHash) {
        success(`Changes committed: ${commitHash}`);
      } else {
        info('No changes to commit');
      }

      info(`Pushing to origin/${branch}...`);
      pushBranch(cwd, branch);
      success(`Pushed to origin/${branch}`);
    } catch (err) {
      error(`Git operation failed: ${getErrorMessage(err)}`);
      return EXIT_GIT_OPERATION_FAILED;
    }
  }

  // --- Step 5: Create PR (if --auto-pr) ---
  if (autoPr) {
    if (skipGit) {
      info('--auto-pr is ignored when --skip-git is specified (no push was performed)');
    } else if (branch) {
      info('Creating pull request...');
      const prTitle = issue ? issue.title : (options.task ?? 'Pipeline task');
      const report = `Piece \`${piece}\` completed successfully.`;
      const prBody = buildPipelinePrBody(pipelineConfig, issue, report);

      const prResult = createPullRequest(cwd, {
        branch,
        title: prTitle,
        body: prBody,
        base: baseBranch,
        repo: options.repo,
      });

      if (prResult.success) {
        success(`PR created: ${prResult.url}`);
      } else {
        error(`PR creation failed: ${prResult.error}`);
        return EXIT_PR_CREATION_FAILED;
      }
    }
  }

  // --- Summary ---
  blankLine();
  status('Issue', issue ? `#${issue.number} "${issue.title}"` : 'N/A');
  status('Branch', branch ?? '(current)');
  status('Piece', piece);
  status('Result', 'Success', 'green');

  return 0;
}
