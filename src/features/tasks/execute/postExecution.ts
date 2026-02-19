/**
 * Shared post-execution logic: auto-commit, push, and PR creation.
 *
 * Used by both selectAndExecuteTask (interactive mode) and
 * instructBranch (instruct mode from takt list).
 */

import { resolvePieceConfigValue } from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { autoCommitAndPush } from '../../../infra/task/index.js';
import { info, error, success } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { createPullRequest, buildPrBody, pushBranch, findExistingPr, commentOnPr } from '../../../infra/github/index.js';
import type { GitHubIssue } from '../../../infra/github/index.js';

const log = createLogger('postExecution');

/**
 * Resolve auto-PR setting with priority: CLI option > config > prompt.
 */
export async function resolveAutoPr(optionAutoPr: boolean | undefined, cwd: string): Promise<boolean> {
  if (typeof optionAutoPr === 'boolean') {
    return optionAutoPr;
  }

  const autoPr = resolvePieceConfigValue(cwd, 'autoPr');
  if (typeof autoPr === 'boolean') {
    return autoPr;
  }
  return confirm('Create pull request?', true);
}

export interface PostExecutionOptions {
  execCwd: string;
  projectCwd: string;
  task: string;
  branch?: string;
  baseBranch?: string;
  shouldCreatePr: boolean;
  pieceIdentifier?: string;
  issues?: GitHubIssue[];
  repo?: string;
}

export interface PostExecutionResult {
  prUrl?: string;
}

/**
 * Auto-commit, push, and optionally create a PR after successful task execution.
 */
export async function postExecutionFlow(options: PostExecutionOptions): Promise<PostExecutionResult> {
  const { execCwd, projectCwd, task, branch, baseBranch, shouldCreatePr, pieceIdentifier, issues, repo } = options;

  const commitResult = autoCommitAndPush(execCwd, task, projectCwd);
  if (commitResult.success && commitResult.commitHash) {
    success(`Auto-committed & pushed: ${commitResult.commitHash}`);
  } else if (!commitResult.success) {
    error(`Auto-commit failed: ${commitResult.message}`);
  }

  if (commitResult.success && commitResult.commitHash && branch && shouldCreatePr) {
    try {
      pushBranch(projectCwd, branch);
    } catch (pushError) {
      log.info('Branch push from project cwd failed (may already exist)', { error: pushError });
    }
    const report = pieceIdentifier ? `Piece \`${pieceIdentifier}\` completed successfully.` : 'Task completed successfully.';
    const existingPr = findExistingPr(projectCwd, branch);
    if (existingPr) {
      // PRが既に存在する場合はコメントを追加（push済みなので新コミットはPRに自動反映）
      const commentBody = buildPrBody(issues, report);
      const commentResult = commentOnPr(projectCwd, existingPr.number, commentBody);
      if (commentResult.success) {
        success(`PR updated with comment: ${existingPr.url}`);
        return { prUrl: existingPr.url };
      } else {
        error(`PR comment failed: ${commentResult.error}`);
      }
    } else {
      info('Creating pull request...');
      const prBody = buildPrBody(issues, report);
      const prResult = createPullRequest(projectCwd, {
        branch,
        title: task.length > 100 ? `${task.slice(0, 97)}...` : task,
        body: prBody,
        base: baseBranch,
        repo,
      });
      if (prResult.success) {
        success(`PR created: ${prResult.url}`);
        return { prUrl: prResult.url };
      } else {
        error(`PR creation failed: ${prResult.error}`);
      }
    }
  }

  return {};
}
