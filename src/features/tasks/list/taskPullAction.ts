import { execFileSync } from 'node:child_process';
import { success, error as logError } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import {
  type BranchActionTarget,
  resolveTargetBranch,
  validateWorktreeTarget,
  pushWorktreeToOrigin,
} from './taskActionTarget.js';

const log = createLogger('list-tasks');

const TEMP_REMOTE_NAME = 'origin';

function getOriginUrl(projectDir: string): string {
  return execFileSync(
    'git', ['config', '--get', 'remote.origin.url'],
    { cwd: projectDir, encoding: 'utf-8', stdio: 'pipe' },
  ).trim();
}

export function pullFromRemote(
  projectDir: string,
  target: BranchActionTarget,
): boolean {
  if (!validateWorktreeTarget(target, 'Pull')) {
    return false;
  }
  const worktreePath = target.worktreePath;
  const branch = resolveTargetBranch(target);

  let originUrl: string;
  try {
    originUrl = getOriginUrl(projectDir);
  } catch (err) {
    logError(`Failed to get origin URL: ${getErrorMessage(err)}`);
    log.error('getOriginUrl failed', { projectDir, error: getErrorMessage(err) });
    return false;
  }
  log.info('Retrieved origin URL from root repo', { projectDir, originUrl });

  try {
    execFileSync('git', ['remote', 'add', TEMP_REMOTE_NAME, originUrl], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('Added temporary origin remote', { worktreePath, originUrl });

    try {
      execFileSync('git', ['pull', '--ff-only', TEMP_REMOTE_NAME, branch], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      log.info('Pull succeeded', { worktreePath, branch });
    } catch (err) {
      const msg = getErrorMessage(err);
      logError(`Pull failed (not fast-forwardable?): ${msg}`);
      logError('If the branch has diverged, use "Sync with root" instead.');
      log.error('git pull --ff-only failed', { worktreePath, branch, error: msg });
      return false;
    }
  } catch (err) {
    logError(`Failed to add temporary remote: ${getErrorMessage(err)}`);
    log.error('git remote add failed', { worktreePath, originUrl, error: getErrorMessage(err) });
    return false;
  } finally {
    removeTemporaryRemote(worktreePath);
  }

  try {
    pushWorktreeToOrigin(worktreePath, projectDir, branch);
  } catch (err) {
    logError(`Push failed after pull: ${getErrorMessage(err)}`);
    log.error('pushWorktreeToOrigin failed', { worktreePath, projectDir, branch, error: getErrorMessage(err) });
    return false;
  }
  success('Pulled & pushed.');
  return true;
}

function removeTemporaryRemote(worktreePath: string): void {
  try {
    execFileSync('git', ['remote', 'remove', TEMP_REMOTE_NAME], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('Removed temporary origin remote', { worktreePath });
  } catch (err) {
    logError(`Failed to remove temporary remote: ${getErrorMessage(err)}`);
    log.error('git remote remove failed', { worktreePath, error: getErrorMessage(err) });
  }
}
