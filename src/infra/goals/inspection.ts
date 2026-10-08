import { readGoalDiffSummary } from './diff-summary.js';
import { GoalStore } from './store.js';
import { getGoalTaskSource } from './integration.js';
import { goalGitText, isGoalCommitIncluded, resolveGoalBranchSha, runGoalGit } from './git-command.js';

export const GOAL_READ_MAX_ITEMS = 50;
export const GOAL_READ_MAX_BYTES = 64 * 1024;

async function inspectionBranches(cwd: string, goalId: string, taskName: string | undefined, targetBranch: string) {
  const goal = await new GoalStore(cwd).get(goalId);
  const sourceBranch = taskName === undefined ? goal.branch : await getGoalTaskSource(cwd, goal, taskName);
  const comparisonBranch = taskName === undefined ? targetBranch : goal.branch;
  return { sourceBranch, comparisonBranch };
}

export async function inspectGoalDiff(
  cwd: string, goalId: string, taskName: string | undefined, targetBranch: string,
  file: string | undefined, limit: number, signal: AbortSignal | undefined,
) {
  const branches = await inspectionBranches(cwd, goalId, taskName, targetBranch);
  const sourceSha = await resolveGoalBranchSha(cwd, branches.sourceBranch, signal);
  const comparisonSha = await resolveGoalBranchSha(cwd, branches.comparisonBranch, signal);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', `${comparisonSha}...${sourceSha}`];
  const summary = await readGoalDiffSummary(cwd, comparisonSha, sourceSha, limit, signal);
  const patch = file === undefined ? undefined
    : await runGoalGit(cwd, [...args, '--', file], 4096, signal);
  return {
    ...branches, sourceSha, comparisonSha, files: summary.files,
    ...(patch === undefined ? {} : { patch: patch.output.toString('utf8') }),
    truncated: summary.truncated || patch?.truncated === true,
  };
}

export async function inspectGoalHistory(
  cwd: string, goalId: string, taskName: string | undefined, targetBranch: string,
  limit: number, signal: AbortSignal | undefined,
) {
  const { sourceBranch } = await inspectionBranches(cwd, goalId, taskName, targetBranch);
  const sourceSha = await resolveGoalBranchSha(cwd, sourceBranch, signal);
  const output = await goalGitText(cwd, ['log', `--max-count=${limit + 1}`, '--format=%H', sourceSha], signal);
  const hashes = output.split('\n').filter(Boolean);
  const commits: { sha: string; message: string; truncated: boolean }[] = [];
  for (const sha of hashes.slice(0, limit)) {
    const message = await runGoalGit(cwd, ['show', '--no-patch', '--format=%B', sha], 128, signal);
    commits.push({ sha, message: message.output.toString('utf8').trimEnd(), truncated: message.truncated });
  }
  return {
    sourceBranch, sourceSha, commits,
    truncated: hashes.length > limit || commits.some((commit) => commit.truncated),
  };
}

export async function inspectGoalRelation(
  cwd: string, goalId: string, targetBranch: string, signal: AbortSignal | undefined,
) {
  const goal = await new GoalStore(cwd).get(goalId);
  const goalSha = await resolveGoalBranchSha(cwd, goal.branch, signal);
  const targetSha = await resolveGoalBranchSha(cwd, targetBranch, signal);
  const included = await isGoalCommitIncluded(cwd, goalSha, targetSha, signal);
  const ahead = Number(await goalGitText(cwd, ['rev-list', '--count', `${targetSha}..${goalSha}`], signal));
  return { goalBranch: goal.branch, goalSha, targetBranch, targetSha, included, ahead };
}
