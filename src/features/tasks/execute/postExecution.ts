/**
 * Shared post-execution logic: auto-commit, push, and PR creation.
 *
 * Used by taskExecution (takt run / watch path) and
 * instructBranch (takt list).
 */

import { autoCommitAndPush } from '../../../infra/task/index.js';
import { pushBranch } from '../../../infra/task/git.js';
import { info, error, success } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import {
  buildPrBody,
  buildTaktManagedPrOptions,
  createPullRequestSafely,
  getGitProvider,
  stripTaktManagedPrMarker,
} from '../../../infra/git/index.js';
import type { Issue, CreatePrResult, GitProvider } from '../../../infra/git/index.js';
import type { ExecuteTaskOptions } from './types.js';

const log = createLogger('postExecution');

const AUTO_COMMIT_FAILURE_MESSAGE = 'Auto-commit failed before PR creation.';
const LOCAL_PUSH_FAILURE_MESSAGE = 'Push to main repo failed after commit creation.';
const ORIGIN_PUSH_FAILURE_MESSAGE = 'Failed to push branch to origin.';
const PR_COMMENT_FAILURE_MESSAGE = 'Failed to update pull request comment.';
const PR_CREATION_FAILURE_MESSAGE = 'Failed to create pull request.';


export interface PostExecutionOptions {
  execCwd: string;
  projectCwd: string;
  task: string;
  branch?: string;
  baseBranch?: string;
  shouldCreatePr: boolean;
  managedPr?: boolean;
  shouldPublishBranchToOrigin?: boolean;
  draftPr: boolean;
  workflowIdentifier?: string;
  issues?: Issue[];
  orderContent?: string;
  repo?: string;
  outputMode?: ExecuteTaskOptions['outputMode'];
  gitProvider?: GitProvider;
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
  const {
    execCwd,
    projectCwd,
    task,
    branch,
    baseBranch,
    shouldCreatePr,
    managedPr,
    shouldPublishBranchToOrigin,
    draftPr,
    workflowIdentifier,
    issues,
    orderContent,
    repo,
    outputMode,
    gitProvider,
  } = options;
  const emitStatusLog = outputMode !== 'silent';

  const commitResult = autoCommitAndPush(execCwd, task, projectCwd, branch);
  if (commitResult.commitHash) {
    if (emitStatusLog) {
      success(`Auto-committed: ${commitResult.commitHash}`);
    }
  } else if (!commitResult.success) {
    log.error('Auto-commit failed before PR handling', {
      outcome: AUTO_COMMIT_FAILURE_MESSAGE,
    });
    if (emitStatusLog) {
      error(AUTO_COMMIT_FAILURE_MESSAGE);
    }
    return { taskFailed: true, taskError: AUTO_COMMIT_FAILURE_MESSAGE };
  }

  if (commitResult.localPushFailed) {
    log.error('Local push failed for task', {
      outcome: LOCAL_PUSH_FAILURE_MESSAGE,
    });
    if (emitStatusLog) {
      error(LOCAL_PUSH_FAILURE_MESSAGE);
    }
    return { taskFailed: true, taskError: LOCAL_PUSH_FAILURE_MESSAGE };
  }

  if (commitResult.commitHash && branch && (shouldPublishBranchToOrigin === true || shouldCreatePr)) {
    try {
      pushBranch(projectCwd, branch);
    } catch (pushError) {
      const pushDetail = getErrorMessage(pushError);
      log.error('Push to origin failed after root branch materialization', {
        branch,
        outcome: ORIGIN_PUSH_FAILURE_MESSAGE,
        error: pushDetail,
      });
      const pushFailureMessage = `${ORIGIN_PUSH_FAILURE_MESSAGE} ${pushDetail}`.trim();
      if (emitStatusLog) {
        error(pushFailureMessage);
      }
      return { prFailed: true, prError: pushFailureMessage };
    }
  }

  if (commitResult.commitHash && branch && shouldCreatePr) {
    const resolvedGitProvider = gitProvider ?? getGitProvider();
    const report = workflowIdentifier ? `Workflow \`${workflowIdentifier}\` completed successfully.` : 'Task completed successfully.';
    const existingPr = resolvedGitProvider.findExistingPr(branch, projectCwd);
    const prBody = stripTaktManagedPrMarker(buildPrBody(issues, report, orderContent));
    if (existingPr) {
      const commentResult = resolvedGitProvider.commentOnPr(existingPr.number, prBody, projectCwd);
      if (commentResult.success) {
        if (emitStatusLog) {
          success(`PR updated with comment: ${existingPr.url}`);
        }
        return { prUrl: existingPr.url };
      } else {
        log.error('PR comment failed', {
          prNumber: existingPr.number,
          outcome: PR_COMMENT_FAILURE_MESSAGE,
        });
        if (emitStatusLog) {
          error(PR_COMMENT_FAILURE_MESSAGE);
        }
        return { prFailed: true, prError: PR_COMMENT_FAILURE_MESSAGE };
      }
    } else {
      if (emitStatusLog) {
        info('Creating pull request...');
      }
      const firstIssue = issues?.[0];
      const issuePrefix = firstIssue ? `[#${firstIssue.number}] ` : '';
      const truncatedTask = task.length > 100 - issuePrefix.length ? `${task.slice(0, 100 - issuePrefix.length - 3)}...` : task;
      const prTitle = issuePrefix + truncatedTask;
      const prResult: CreatePrResult = createPullRequestSafely(resolvedGitProvider, {
        branch,
        title: prTitle,
        ...(managedPr === true ? buildTaktManagedPrOptions(prBody) : { body: prBody }),
        base: baseBranch,
        repo,
        draft: draftPr,
      }, projectCwd);
      if (prResult.success) {
        if (emitStatusLog) {
          success(`PR created: ${prResult.url}`);
        }
        return { prUrl: prResult.url };
      } else {
        const detailedPrError = prResult.error
          ? `${PR_CREATION_FAILURE_MESSAGE} ${prResult.error}`
          : PR_CREATION_FAILURE_MESSAGE;
        log.error('PR creation failed', {
          branch,
          baseBranch,
          outcome: detailedPrError,
        });
        if (emitStatusLog) {
          error(detailedPrError);
        }
        return { prFailed: true, prError: detailedPrError };
      }
    }
  }

  return {};
}
