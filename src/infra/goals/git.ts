import { execFileSync } from 'node:child_process';
import { detectDefaultBranch } from '../task/branchList.js';
import { resolveConfigValue } from '../config/index.js';
import { assertValidLocalBranchName, toLocalBranchRef, toRemoteTrackingBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createTimestampedTaktBranchName } from '../../shared/utils/takt-branch-name.js';
import { createLogger } from '../../shared/utils/debug.js';
import { goalGitText, runGoalGit } from './git-command.js';
import { GoalIdSchema } from './schema.js';

const log = createLogger('goals');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

async function hasExactRef(cwd: string, ref: string): Promise<boolean> {
  const expected = Buffer.from(`${ref}\n`);
  const result = await runGoalGit(cwd, ['for-each-ref', '--format=%(refname)', '--count=1', ref], expected.length, undefined);
  return !result.truncated && result.output.equals(expected);
}

async function resolveDefaultBranchRef(cwd: string, branch: string): Promise<string> {
  const remoteRef = toRemoteTrackingBranchRef(branch);
  if (await hasExactRef(cwd, remoteRef)) return remoteRef;
  const localRef = toLocalBranchRef(branch);
  return await hasExactRef(cwd, localRef) ? localRef : remoteRef;
}

export async function prepareGoalBranch(cwd: string, id: string, requestedStart: string | undefined,
  requestedIntegration: string | undefined) {
  GoalIdSchema.parse(id);
  const configuredIntegration = requestedIntegration ?? resolveConfigValue(cwd, 'baseBranch');
  const startBranch = requestedStart ?? configuredIntegration ?? detectDefaultBranch(cwd);
  const integrationBranch = configuredIntegration ?? startBranch;
  assertValidLocalBranchName(startBranch);
  assertValidLocalBranchName(integrationBranch);
  try {
    await goalGitText(cwd, ['fetch', 'origin'], undefined);
  } catch (error) {
    log.info('Failed to fetch from remote, continuing with local state', { startBranch, error: String(error) });
  }
  const startRef = requestedStart === undefined
    ? await resolveDefaultBranchRef(cwd, startBranch)
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
