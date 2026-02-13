/**
 * Task execution orchestration.
 *
 * Coordinates piece selection, worktree creation, task execution,
 * auto-commit, and PR creation. Extracted from cli.ts to avoid
 * mixing CLI parsing with business logic.
 */

import {
  listPieces,
  isPiecePath,
  loadGlobalConfig,
} from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { createSharedClone, autoCommitAndPush, summarizeTaskName, getCurrentBranch } from '../../../infra/task/index.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import { info, error, success, withProgress } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { createPullRequest, buildPrBody, pushBranch } from '../../../infra/github/index.js';
import { executeTask } from './taskExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectPiece } from '../../pieceSelection/index.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

export async function determinePiece(cwd: string, override?: string): Promise<string | null> {
  if (override) {
    if (isPiecePath(override)) {
      return override;
    }
    const availablePieces = listPieces(cwd);
    const knownPieces = availablePieces.length === 0 ? [DEFAULT_PIECE_NAME] : availablePieces;
    if (!knownPieces.includes(override)) {
      error(`Piece not found: ${override}`);
      return null;
    }
    return override;
  }
  return selectPiece(cwd);
}

export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
  createWorktreeOverride?: boolean | undefined,
): Promise<WorktreeConfirmationResult> {
  const useWorktree =
    typeof createWorktreeOverride === 'boolean'
      ? createWorktreeOverride
      : await confirm('Create worktree?', true);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  const baseBranch = getCurrentBranch(cwd);

  const taskSlug = await withProgress(
    'Generating branch name...',
    (slug) => `Branch name generated: ${slug}`,
    () => summarizeTaskName(task, { cwd }),
  );

  const result = await withProgress(
    'Creating clone...',
    (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
    async () => createSharedClone(cwd, {
      worktree: true,
      taskSlug,
    }),
  );

  return { execCwd: result.path, isWorktree: true, branch: result.branch, baseBranch };
}

/**
 * Resolve auto-PR setting with priority: CLI option > config > prompt.
 * Only applicable when worktree is enabled.
 */
async function resolveAutoPr(optionAutoPr: boolean | undefined): Promise<boolean> {
  // CLI option takes precedence
  if (typeof optionAutoPr === 'boolean') {
    return optionAutoPr;
  }

  // Check global config
  const globalConfig = loadGlobalConfig();
  if (typeof globalConfig.autoPr === 'boolean') {
    return globalConfig.autoPr;
  }

  // Fall back to interactive prompt
  return confirm('Create pull request?', true);
}

/**
 * Execute a task with piece selection, optional worktree, and auto-commit.
 * Shared by direct task execution and interactive mode.
 */
export async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void> {
  const pieceIdentifier = await determinePiece(cwd, options?.piece);

  if (pieceIdentifier === null) {
    info('Cancelled');
    return;
  }

  const { execCwd, isWorktree, branch, baseBranch } = await confirmAndCreateWorktree(
    cwd,
    task,
    options?.createWorktree,
  );

  // Ask for PR creation BEFORE execution (only if worktree is enabled)
  let shouldCreatePr = false;
  if (isWorktree) {
    shouldCreatePr = await resolveAutoPr(options?.autoPr);
  }

  log.info('Starting task execution', { piece: pieceIdentifier, worktree: isWorktree, autoPr: shouldCreatePr });
  const taskSuccess = await executeTask({
    task,
    cwd: execCwd,
    pieceIdentifier,
    projectCwd: cwd,
    agentOverrides,
    interactiveUserInput: options?.interactiveUserInput === true,
    interactiveMetadata: options?.interactiveMetadata,
  });

  if (taskSuccess && isWorktree) {
    const commitResult = autoCommitAndPush(execCwd, task, cwd);
    if (commitResult.success && commitResult.commitHash) {
      success(`Auto-committed & pushed: ${commitResult.commitHash}`);
    } else if (!commitResult.success) {
      error(`Auto-commit failed: ${commitResult.message}`);
    }

    if (commitResult.success && commitResult.commitHash && branch && shouldCreatePr) {
      info('Creating pull request...');
      // Push branch from project cwd to origin (clone's origin is removed after shared clone)
      try {
        pushBranch(cwd, branch);
      } catch (pushError) {
        // Branch may already be pushed by autoCommitAndPush, continue to PR creation
        log.info('Branch push from project cwd failed (may already exist)', { error: pushError });
      }
      const prBody = buildPrBody(options?.issues, `Piece \`${pieceIdentifier}\` completed successfully.`);
      const prResult = createPullRequest(cwd, {
        branch,
        title: task.length > 100 ? `${task.slice(0, 97)}...` : task,
        body: prBody,
        base: baseBranch,
        repo: options?.repo,
      });
      if (prResult.success) {
        success(`PR created: ${prResult.url}`);
      } else {
        error(`PR creation failed: ${prResult.error}`);
      }
    }
  }

  if (!taskSuccess) {
    process.exit(1);
  }
}
