/**
 * Shared post-execution logic: auto-commit, push, and PR creation.
 *
 * Used by taskExecution (takt run / watch path) and
 * instructBranch (takt list).
 */

import { autoCommitAndPush, pushBranch } from '../../../infra/task/index.js';
import { info, error, success } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { buildPrBody } from '../../../infra/github/index.js';
import { getGitProvider } from '../../../infra/git/index.js';
import type { Issue } from '../../../infra/git/index.js';

const log = createLogger('postExecution');


export interface PostExecutionOptions {
  execCwd: string;
  projectCwd: string;
  task: string;
  branch?: string;
  baseBranch?: string;
  shouldCreatePr: boolean;
  draftPr: boolean;
  pieceIdentifier?: string;
  issues?: Issue[];
  repo?: string;
}

export interface PostExecutionResult {
  prUrl?: string;
  prFailed?: boolean;
  prError?: string;
}

/**
 * Auto-commit, push, and optionally create a PR after successful task execution.
 */
export async function postExecutionFlow(options: PostExecutionOptions): Promise<PostExecutionResult> {
  const { execCwd, projectCwd, task, branch, baseBranch, shouldCreatePr, draftPr, pieceIdentifier, issues, repo } = options;

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
    const gitProvider = getGitProvider();
    const report = pieceIdentifier ? `Piece \`${pieceIdentifier}\` completed successfully.` : 'Task completed successfully.';
    const existingPr = gitProvider.findExistingPr(projectCwd, branch);
    if (existingPr) {
      // push済みなので、新コミットはPRに自動反映される
      const commentBody = buildPrBody(issues, report);
      const commentResult = gitProvider.commentOnPr(projectCwd, existingPr.number, commentBody);
      if (commentResult.success) {
        success(`PR updated with comment: ${existingPr.url}`);
        return { prUrl: existingPr.url };
      } else {
        error(`PR comment failed: ${commentResult.error}`);
        return { prFailed: true, prError: commentResult.error };
      }
    } else {
      info('Creating pull request...');
      const prBody = buildPrBody(issues, report);
      const firstIssue = issues?.[0];
      const issuePrefix = firstIssue ? `[#${firstIssue.number}] ` : '';
      const truncatedTask = task.length > 100 - issuePrefix.length ? `${task.slice(0, 100 - issuePrefix.length - 3)}...` : task;
      const prTitle = issuePrefix + truncatedTask;
      const prResult = gitProvider.createPullRequest(projectCwd, {
        branch,
        title: prTitle,
        body: prBody,
        base: baseBranch,
        repo,
        draft: draftPr,
      });
      if (prResult.success) {
        success(`PR created: ${prResult.url}`);
        return { prUrl: prResult.url };
      } else {
        error(`PR creation failed: ${prResult.error}`);
        return { prFailed: true, prError: prResult.error };
      }
    }
  }

  return {};
}
