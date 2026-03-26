/**
 * Shared post-execution logic: auto-commit, push, and PR creation.
 *
 * Used by taskExecution (takt run / watch path) and
 * instructBranch (takt list).
 */

import { autoCommitAndPush } from '../../../infra/task/index.js';
import { pushBranch } from '../../../infra/task/git.js';
import { info, error, success } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { buildPrBody, createPullRequestSafely, getGitProvider } from '../../../infra/git/index.js';
import type { Issue, CreatePrResult } from '../../../infra/git/index.js';

const log = createLogger('postExecution');

const AUTO_COMMIT_FAILURE_MESSAGE = 'Auto-commit failed before PR creation.';
const LOCAL_PUSH_FAILURE_MESSAGE = 'Push to main repo failed after commit creation.';
const BRANCH_PUSH_FAILURE_MESSAGE = 'Failed to push branch to origin.';
const PR_COMMENT_FAILURE_MESSAGE = 'Failed to update pull request comment.';
const PR_CREATION_FAILURE_MESSAGE = 'Failed to create pull request.';


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
  taskFailed?: boolean;
  taskError?: string;
}

/**
 * Auto-commit, push, and optionally create a PR after successful task execution.
 */
export async function postExecutionFlow(options: PostExecutionOptions): Promise<PostExecutionResult> {
  const { execCwd, projectCwd, task, branch, baseBranch, shouldCreatePr, draftPr, pieceIdentifier, issues, repo } = options;

  const commitResult = autoCommitAndPush(execCwd, task, projectCwd);
  if (commitResult.commitHash) {
    success(`Auto-committed: ${commitResult.commitHash}`);
  } else if (!commitResult.success) {
    log.error('Auto-commit failed before PR handling', {
      outcome: AUTO_COMMIT_FAILURE_MESSAGE,
    });
    error(AUTO_COMMIT_FAILURE_MESSAGE);
    return { taskFailed: true, taskError: AUTO_COMMIT_FAILURE_MESSAGE };
  }

  if (commitResult.localPushFailed && !shouldCreatePr) {
    log.error('Local push failed for task without PR creation', {
      outcome: LOCAL_PUSH_FAILURE_MESSAGE,
    });
    error(LOCAL_PUSH_FAILURE_MESSAGE);
    return { taskFailed: true, taskError: LOCAL_PUSH_FAILURE_MESSAGE };
  }

  if (commitResult.commitHash && branch && shouldCreatePr) {
    try {
      pushBranch(projectCwd, branch);
    } catch (pushError) {
      void pushError;
      log.error('Branch push to origin failed', {
        branch,
        outcome: BRANCH_PUSH_FAILURE_MESSAGE,
      });
      error(BRANCH_PUSH_FAILURE_MESSAGE);
      return { prFailed: true, prError: BRANCH_PUSH_FAILURE_MESSAGE };
    }
    const gitProvider = getGitProvider();
    const report = pieceIdentifier ? `Piece \`${pieceIdentifier}\` completed successfully.` : 'Task completed successfully.';
    const existingPr = gitProvider.findExistingPr(branch, projectCwd);
    if (existingPr) {
      // push済みなので、新コミットはPRに自動反映される
      const commentBody = buildPrBody(issues, report);
      const commentResult = gitProvider.commentOnPr(existingPr.number, commentBody, projectCwd);
      if (commentResult.success) {
        success(`PR updated with comment: ${existingPr.url}`);
        return { prUrl: existingPr.url };
      } else {
        log.error('PR comment failed', {
          prNumber: existingPr.number,
          outcome: PR_COMMENT_FAILURE_MESSAGE,
        });
        error(PR_COMMENT_FAILURE_MESSAGE);
        return { prFailed: true, prError: PR_COMMENT_FAILURE_MESSAGE };
      }
    } else {
      info('Creating pull request...');
      const prBody = buildPrBody(issues, report);
      const firstIssue = issues?.[0];
      const issuePrefix = firstIssue ? `[#${firstIssue.number}] ` : '';
      const truncatedTask = task.length > 100 - issuePrefix.length ? `${task.slice(0, 100 - issuePrefix.length - 3)}...` : task;
      const prTitle = issuePrefix + truncatedTask;
      const prResult: CreatePrResult = createPullRequestSafely(gitProvider, {
        branch,
        title: prTitle,
        body: prBody,
        base: baseBranch,
        repo,
        draft: draftPr,
      }, projectCwd);
      if (prResult.success) {
        success(`PR created: ${prResult.url}`);
        return { prUrl: prResult.url };
      } else {
        log.error('PR creation failed', {
          branch,
          baseBranch,
          outcome: PR_CREATION_FAILURE_MESSAGE,
        });
        error(PR_CREATION_FAILURE_MESSAGE);
        return { prFailed: true, prError: PR_CREATION_FAILURE_MESSAGE };
      }
    }
  }

  return {};
}
