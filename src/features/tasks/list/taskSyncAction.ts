import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { executeTask } from '../execute/taskExecution.js';
import { determinePiece } from '../execute/selectAndExecute.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';
import { type BranchActionTarget, resolveTargetInstruction } from './taskActionTarget.js';
import type { TaskExecutionOptions } from '../execute/types.js';

const log = createLogger('list-tasks');

const SYNC_REF = 'refs/remotes/root/sync-target';

function buildConflictResolutionInstruction(originalInstruction: string): string {
  return `Git merge has stopped due to merge conflicts.

Resolve all conflicts to complete the merge:
1. Run \`git status\` to identify conflicted files
2. For each conflicted file, resolve the conflict markers
   (<<<<<<< HEAD / ======= / >>>>>>> lines)
   Preserve changes that align with the original task intent
3. Stage each resolved file: \`git add <file>\`
4. Complete the merge: \`git commit\`

Original task:
${originalInstruction}`;
}

export async function syncBranchWithRoot(
  projectDir: string,
  target: BranchActionTarget,
  options?: TaskExecutionOptions,
): Promise<boolean> {
  if (!('kind' in target)) {
    throw new Error('Sync requires a task target.');
  }

  if (!target.worktreePath || !fs.existsSync(target.worktreePath)) {
    logError(`Worktree directory does not exist for task: ${target.name}`);
    return false;
  }
  const worktreePath = target.worktreePath;

  // origin is removed in worktrees; pass the project path directly as the remote
  try {
    execFileSync('git', ['fetch', projectDir, `HEAD:${SYNC_REF}`], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('Fetched root HEAD into sync-target ref', { worktreePath, projectDir });
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to fetch from root: ${msg}`);
    log.error('git fetch failed', { worktreePath, projectDir, error: msg });
    return false;
  }

  try {
    execFileSync('git', ['merge', SYNC_REF], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    success('Synced.');
    log.info('Merge succeeded without conflicts', { worktreePath });
    return true;
  } catch (err) {
    log.info('Merge conflict detected, attempting AI resolution', {
      worktreePath,
      error: getErrorMessage(err),
    });
  }

  const pieceIdentifier = await determinePiece(projectDir, target.data?.piece ?? DEFAULT_PIECE_NAME);
  if (!pieceIdentifier) {
    abortMerge(worktreePath);
    return false;
  }

  const originalInstruction = resolveTargetInstruction(target);
  const conflictInstruction = buildConflictResolutionInstruction(originalInstruction);

  const aiSuccess = await executeTask({
    task: conflictInstruction,
    cwd: worktreePath,
    pieceIdentifier,
    projectCwd: projectDir,
    agentOverrides: options,
  });

  if (aiSuccess) {
    success('Conflicts resolved.');
    log.info('AI conflict resolution succeeded', { worktreePath });
    return true;
  }

  abortMerge(worktreePath);
  logError('Failed to resolve conflicts. Merge aborted.');
  return false;
}

function abortMerge(worktreePath: string): void {
  try {
    execFileSync('git', ['merge', '--abort'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('git merge --abort completed', { worktreePath });
  } catch (err) {
    log.error('git merge --abort failed', { worktreePath, error: getErrorMessage(err) });
  }
}
