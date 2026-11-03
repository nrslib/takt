import { execFileSync } from 'node:child_process';
import { detectDefaultBranch } from '../task/branchList.js';
import { resolveConfigValue } from '../config/index.js';
import { assertValidLocalBranchName, toLocalBranchRef, toRemoteTrackingBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createTimestampedTaktBranchName } from '../../shared/utils/takt-branch-name.js';
import { createLogger } from '../../shared/utils/debug.js';
import { goalGitText, runGoalGit } from './git-command.js';
import { GoalIdSchema } from './schema.js';

const log = createLogger('goals');
const GOAL_FETCH_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

async function hasExactRef(cwd: string, ref: string, signal: AbortSignal | undefined): Promise<boolean> {
  const expected = Buffer.from(`${ref}\n`);
  const result = await runGoalGit(cwd, ['for-each-ref', '--format=%(refname)', '--count=1', ref], expected.length, signal);
  return !result.truncated && result.output.equals(expected);
}

async function resolveDefaultBranchRef(cwd: string, branch: string, fetchSucceeded: boolean, signal: AbortSignal | undefined): Promise<string> {
  const remoteRef = toRemoteTrackingBranchRef(branch);
  if (fetchSucceeded && await hasExactRef(cwd, remoteRef, signal)) return remoteRef;
  const localRef = toLocalBranchRef(branch);
  return await hasExactRef(cwd, localRef, signal) ? localRef : remoteRef;
}

export async function prepareGoalBranch(cwd: string, id: string, requestedStart: string | undefined,
  requestedIntegration: string | undefined, signal?: AbortSignal) {
  signal?.throwIfAborted();
  GoalIdSchema.parse(id);
  const configuredIntegration = requestedIntegration ?? resolveConfigValue(cwd, 'baseBranch');
  const startBranch = requestedStart ?? configuredIntegration ?? detectDefaultBranch(cwd);
  const integrationBranch = configuredIntegration ?? startBranch;
  assertValidLocalBranchName(startBranch);
  assertValidLocalBranchName(integrationBranch);
  let fetchSucceeded = false;
  if (requestedStart === undefined) {
    try {
      const timeout = AbortSignal.timeout(GOAL_FETCH_TIMEOUT_MS);
      await goalGitText(cwd, ['fetch', 'origin'], signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
      fetchSucceeded = true;
    } catch (error) {
      signal?.throwIfAborted();
      log.info('Failed to fetch from remote, continuing with local state', { startBranch, error: String(error) });
    }
  }
  const startRef = requestedStart === undefined
    ? await resolveDefaultBranchRef(cwd, startBranch, fetchSucceeded, signal)
    : toLocalBranchRef(startBranch);
  signal?.throwIfAborted();
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

export async function restoreGoalBranch(cwd: string, branch: string, commit: string): Promise<void> {
  const ref = toLocalBranchRef(branch);
  if (!await hasExactRef(cwd, ref, undefined)) {
    await goalGitText(cwd, ['update-ref', ref, commit, ''], undefined);
  }
}
