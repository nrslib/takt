/**
 * Shared post-execution logic: auto-commit, push, and PR creation.
 *
 * Used by both selectAndExecuteTask (interactive mode) and
 * instructBranch (instruct mode from takt list).
 */

import { loadGlobalConfig } from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { autoCommitAndPush } from '../../../infra/task/index.js';
import { info, error, success } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { createPullRequest, buildPrBody, pushBranch } from '../../../infra/github/index.js';
import type { GitHubIssue } from '../../../infra/github/index.js';

const log = createLogger('postExecution');

async function resolveBooleanOption(
  cliValue: boolean | undefined,
  configValue: boolean | undefined,
  promptText: string,
): Promise<boolean> {
  if (typeof cliValue === 'boolean') {
    return cliValue;
  }
  if (typeof configValue === 'boolean') {
    return configValue;
  }
  return confirm(promptText, true);
}

/**
 * Resolve auto-PR setting with priority: CLI option > config > prompt.
 */
export async function resolveAutoPr(optionAutoPr: boolean | undefined): Promise<boolean> {
  const globalConfig = loadGlobalConfig();
  return resolveBooleanOption(optionAutoPr, globalConfig.autoPr, 'Create pull request?');
}

/**
 * Resolve auto-PR draft setting with priority: CLI option > config > prompt.
 * Only called when auto-PR is enabled.
 */
export async function resolveAutoPrDraft(optionAutoPrDraft: boolean | undefined): Promise<boolean> {
  const globalConfig = loadGlobalConfig();
  return resolveBooleanOption(optionAutoPrDraft, globalConfig.autoPrDraft, 'Create as draft?');
}

export interface PostExecutionOptions {
  execCwd: string;
  projectCwd: string;
  task: string;
  branch?: string;
  baseBranch?: string;
  shouldCreatePr: boolean;
  draft?: boolean;
  pieceIdentifier?: string;
  issues?: GitHubIssue[];
  repo?: string;
}

/**
 * Auto-commit, push, and optionally create a PR after successful task execution.
 */
export async function postExecutionFlow(options: PostExecutionOptions): Promise<void> {
  const { execCwd, projectCwd, task, branch, baseBranch, shouldCreatePr, draft, pieceIdentifier, issues, repo } = options;

  const commitResult = autoCommitAndPush(execCwd, task, projectCwd);
  if (commitResult.success && commitResult.commitHash) {
    success(`Auto-committed & pushed: ${commitResult.commitHash}`);
  } else if (!commitResult.success) {
    error(`Auto-commit failed: ${commitResult.message}`);
  }

  if (commitResult.success && commitResult.commitHash && branch && shouldCreatePr) {
    info(draft ? 'Creating draft pull request...' : 'Creating pull request...');
    try {
      pushBranch(projectCwd, branch);
    } catch (pushError) {
      log.info('Branch push from project cwd failed (may already exist)', { error: pushError });
    }
    const report = pieceIdentifier ? `Piece \`${pieceIdentifier}\` completed successfully.` : 'Task completed successfully.';
    const prBody = buildPrBody(issues, report);
    const prResult = createPullRequest(projectCwd, {
      branch,
      title: task.length > 100 ? `${task.slice(0, 97)}...` : task,
      body: prBody,
      base: baseBranch,
      repo,
      draft,
    });
    if (prResult.success) {
      success(draft ? `Draft PR created: ${prResult.url}` : `PR created: ${prResult.url}`);
    } else {
      error(`PR creation failed: ${prResult.error}`);
    }
  }
}
