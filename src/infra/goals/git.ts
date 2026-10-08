import { execFileSync } from 'node:child_process';
import { detectDefaultBranch } from '../task/branchList.js';
import { resolveConfigValue } from '../config/index.js';
import { toLocalBranchRef, toRemoteTrackingBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createTimestampedTaktBranchName } from '../../shared/utils/takt-branch-name.js';
import { GoalIdSchema } from './schema.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function resolveDefaultBranchRef(cwd: string, branch: string): string {
  const localRef = toLocalBranchRef(branch);
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)', localRef]);
  return refs.split('\n').includes(localRef) ? localRef : toRemoteTrackingBranchRef(branch);
}

export function prepareGoalBranch(cwd: string, id: string, requestedStart: string | undefined,
  requestedIntegration: string | undefined) {
  GoalIdSchema.parse(id);
  const startBranch = requestedStart ?? detectDefaultBranch(cwd);
  const configuredIntegration = requestedIntegration ?? resolveConfigValue(cwd, 'baseBranch');
  const integrationBranch = configuredIntegration ?? startBranch;
  const startRef = requestedStart === undefined
    ? resolveDefaultBranchRef(cwd, startBranch)
    : toLocalBranchRef(startBranch);
  const commit = git(cwd, ['rev-parse', '--verify', `${startRef}^{commit}`]);
  if (configuredIntegration !== undefined) {
    git(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(configuredIntegration)}^{commit}`]);
  }
  const branch = createTimestampedTaktBranchName(`goal-${id.slice(0, 8)}`);
  return { branch, startBranch, integrationBranch, commit };
}

export function createGoalBranch(cwd: string, branch: string, commit: string): void {
  // Empty old value makes creation conditional on the reference being absent.
  git(cwd, ['update-ref', toLocalBranchRef(branch), commit, '']);
}

export function removeGoalBranch(cwd: string, branch: string, commit: string): void {
  git(cwd, ['update-ref', '-d', toLocalBranchRef(branch), commit]);
}
