/**
 * Pipeline execution flow
 *
 * Orchestrates the full pipeline:
 *   1. Fetch issue content
 *   2. Create branch
 *   3. Run workflow
 *   4. Commit & push
 *   5. Create PR
 */

import { execFileSync } from 'node:child_process';
import { fetchIssue, formatIssueAsTask, checkGhCli, type GitHubIssue } from '../github/issue.js';
import { createPullRequest, pushBranch, buildPrBody } from '../github/pr.js';
import { executeTask, type TaskExecutionOptions } from './taskExecution.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { info, error, success, status } from '../utils/ui.js';
import { createLogger } from '../utils/debug.js';
import type { PipelineConfig } from '../models/types.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_WORKFLOW_FAILED,
  EXIT_GIT_OPERATION_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../exitCodes.js';
import type { ProviderType } from '../providers/index.js';

const log = createLogger('pipeline');

export interface PipelineExecutionOptions {
  /** GitHub issue number */
  issueNumber?: number;
  /** Task content (alternative to issue) */
  task?: string;
  /** Workflow name or path to workflow file */
  workflow: string;
  /** Branch name (auto-generated if omitted) */
  branch?: string;
  /** Whether to create a PR after successful execution */
  autoPr: boolean;
  /** Repository in owner/repo format */
  repo?: string;
  /** Skip branch creation, commit, and push (workflow-only execution) */
  skipGit?: boolean;
  /** Working directory */
  cwd: string;
  provider?: ProviderType;
  model?: string;
}

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

/** Stage all changes and create a commit */
function commitChanges(cwd: string, message: string): string | undefined {
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });

  const statusOutput = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (!statusOutput.trim()) {
    return undefined;
  }

  execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'pipe' });

  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
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
  return buildPrBody(issue, report);
}

/**
 * Execute the full pipeline.
 *
 * Returns a process exit code (0 on success, 2-5 on specific failures).
 */
export async function executePipeline(options: PipelineExecutionOptions): Promise<number> {
  const { cwd, workflow, autoPr, skipGit } = options;
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
      error(`Failed to fetch issue #${options.issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
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
  if (!skipGit) {
    branch = options.branch ?? generatePipelineBranchName(pipelineConfig, options.issueNumber);
    info(`Creating branch: ${branch}`);
    try {
      createBranch(cwd, branch);
      success(`Branch created: ${branch}`);
    } catch (err) {
      error(`Failed to create branch: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_GIT_OPERATION_FAILED;
    }
  }

  // --- Step 3: Run workflow ---
  info(`Running workflow: ${workflow}`);
  log.info('Pipeline workflow execution starting', { workflow, branch, skipGit, issueNumber: options.issueNumber });

  const agentOverrides: TaskExecutionOptions | undefined = (options.provider || options.model)
    ? { provider: options.provider, model: options.model }
    : undefined;

  const taskSuccess = await executeTask(task, cwd, workflow, cwd, agentOverrides);

  if (!taskSuccess) {
    error(`Workflow '${workflow}' failed`);
    return EXIT_WORKFLOW_FAILED;
  }
  success(`Workflow '${workflow}' completed`);

  // --- Step 4: Commit & push (skip if --skip-git) ---
  if (!skipGit && branch) {
    const commitMessage = buildCommitMessage(pipelineConfig, issue, options.task);

    info('Committing changes...');
    try {
      const commitHash = commitChanges(cwd, commitMessage);
      if (commitHash) {
        success(`Changes committed: ${commitHash}`);
      } else {
        info('No changes to commit');
      }

      info(`Pushing to origin/${branch}...`);
      pushBranch(cwd, branch);
      success(`Pushed to origin/${branch}`);
    } catch (err) {
      error(`Git operation failed: ${err instanceof Error ? err.message : String(err)}`);
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
      const report = `Workflow \`${workflow}\` completed successfully.`;
      const prBody = buildPipelinePrBody(pipelineConfig, issue, report);

      const prResult = createPullRequest(cwd, {
        branch,
        title: prTitle,
        body: prBody,
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
  console.log();
  status('Issue', issue ? `#${issue.number} "${issue.title}"` : 'N/A');
  status('Branch', branch ?? '(current)');
  status('Workflow', workflow);
  status('Result', 'Success', 'green');

  return 0;
}
