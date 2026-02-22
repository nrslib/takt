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
import { stageAndCommit, resolveBaseBranch } from '../../infra/task/index.js';
import { executeTask, confirmAndCreateWorktree, type TaskExecutionOptions, type PipelineExecutionOptions } from '../tasks/index.js';
import { resolveConfigValues } from '../../infra/config/index.js';
import { info, error, success, status, blankLine } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage, getSlackWebhookUrl, sendSlackNotification, buildSlackRunSummary } from '../../shared/utils/index.js';
import type { SlackTaskDetail } from '../../shared/utils/index.js';
import { generateRunId } from '../tasks/execute/slackSummaryAdapter.js';
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

interface ExecutionContext {
  execCwd: string;
  branch?: string;
  baseBranch?: string;
  isWorktree: boolean;
}

/**
 * Resolve the execution environment for the pipeline.
 * Creates a worktree, a branch, or uses the current directory as-is.
 */
async function resolveExecutionContext(
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
  createBranch(cwd, branch);
  success(`Branch created: ${branch}`);
  return { execCwd: cwd, branch, baseBranch: resolved.branch, isWorktree: false };
}

/**
 * Execute the full pipeline.
 *
 * Returns a process exit code (0 on success, 2-5 on specific failures).
 */
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const { cwd, piece, autoPr, draftPr, skipGit } = options;
  const globalConfig = resolveConfigValues(cwd, ['pipeline']);
  const pipelineConfig = globalConfig.pipeline;
  let issue: GitHubIssue | undefined;
  let task: string;

  const startTime = Date.now();
  const runId = generateRunId();
  let pipelineResult: PipelineResult = { success: false, piece, issueNumber: options.issueNumber };

  try {
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

    // --- Step 2: Prepare execution environment ---
    let context: ExecutionContext;
    try {
      context = await resolveExecutionContext(cwd, task, options, pipelineConfig);
    } catch (err) {
      error(`Failed to prepare execution environment: ${getErrorMessage(err)}`);
      return EXIT_GIT_OPERATION_FAILED;
    }
    const { execCwd, branch, baseBranch, isWorktree } = context;
    pipelineResult = { ...pipelineResult, branch };

    // --- Step 3: Run piece ---
    info(`Running piece: ${piece}`);
    log.info('Pipeline piece execution starting', { piece, branch, skipGit, issueNumber: options.issueNumber });

    const agentOverrides: TaskExecutionOptions | undefined = (options.provider || options.model)
      ? { provider: options.provider, model: options.model }
      : undefined;

    const taskSuccess = await executeTask({
      task,
      cwd: execCwd,
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
        const commitHash = stageAndCommit(execCwd, commitMessage);
        if (commitHash) {
          success(`Changes committed: ${commitHash}`);
        } else {
          info('No changes to commit');
        }

        if (isWorktree) {
          // Clone has no origin — push to main project via path, then project pushes to origin
          execFileSync('git', ['push', cwd, 'HEAD'], { cwd: execCwd, stdio: 'pipe' });
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
          draft: draftPr,
        });

        if (prResult.success) {
          success(`PR created: ${prResult.url}`);
          pipelineResult = { ...pipelineResult, prUrl: prResult.url };
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

    pipelineResult = { ...pipelineResult, success: true };
    return 0;
  } finally {
    await notifySlack(runId, startTime, pipelineResult);
  }
}

/** Intermediate result tracking for Slack notification */
interface PipelineResult {
  success: boolean;
  piece: string;
  issueNumber?: number;
  branch?: string;
  prUrl?: string;
}

/** Send Slack notification if webhook is configured. Never throws. */
async function notifySlack(runId: string, startTime: number, result: PipelineResult): Promise<void> {
  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) return;

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const task: SlackTaskDetail = {
    name: 'pipeline',
    success: result.success,
    piece: result.piece,
    issueNumber: result.issueNumber,
    durationSec,
    branch: result.branch,
    prUrl: result.prUrl,
  };
  const message = buildSlackRunSummary({
    runId,
    total: 1,
    success: result.success ? 1 : 0,
    failed: result.success ? 0 : 1,
    durationSec,
    concurrency: 1,
    tasks: [task],
  });

  await sendSlackNotification(webhookUrl, message);
}
