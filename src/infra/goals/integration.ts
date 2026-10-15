import { spawnSync } from 'node:child_process';
import { TaskRunner } from '../task/runner.js';
import { buildSafeGitEnvironment } from '../task/git-environment.js';
import { GoalStore } from './store.js';
import type { Goal } from './schema.js';
import { mergeGoalBranch, targetWorktrees } from './merge-git.js';
import { isGoalCommitIncluded, resolveGoalBranchSha } from './git-command.js';
import { GOAL_DIFF_MAX_FILES, readGoalDiffSummary } from './diff-summary.js';
import { appendGoalNotification, formatIntegratedWorkNotification, type GoalNotificationPolicy } from './notifications.js';
import { appendGoalWorkLog } from './workLog.js';
import type { Language } from '../../core/models/types.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';

export async function getGoalTaskSource(cwd: string, goal: Goal, taskName: string): Promise<string> {
  const task = new TaskRunner(cwd).listTaskStateItems().find((item) => item.name === taskName);
  if (task === undefined || task.goalId !== goal.id) throw new Error('Task does not belong to this goal');
  const branch = task.completion?.branch;
  if (branch === undefined || (task.branch !== undefined && task.branch !== branch)) {
    throw new Error('Task has no consistent saved result branch');
  }
  const { goals } = await new GoalStore(cwd).list();
  if (goals.some((saved) => saved.branch === branch)) throw new Error('A goal branch is not a task result branch');
  return branch;
}

export async function assertReviewedGoalSha(
  cwd: string, branch: string, expectedSha: string, signal: AbortSignal | undefined,
): Promise<void> {
  const actual = await resolveGoalBranchSha(cwd, branch, signal);
  if (actual !== expectedSha) throw new Error(`Reviewed SHA changed: expected ${expectedSha}, current ${actual}`);
}

export async function integrateGoalTask(
  cwd: string, goalId: string, taskName: string, expectedSha: string, signal: AbortSignal | undefined,
  notifications: GoalNotificationPolicy, language: Language,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  const sourceBranch = await getGoalTaskSource(cwd, goal, taskName);
  await assertReviewedGoalSha(cwd, sourceBranch, expectedSha, signal);
  const targetSha = await resolveGoalBranchSha(cwd, goal.branch, signal);
  if (await isGoalCommitIncluded(cwd, expectedSha, targetSha, signal)) {
    return { status: 'merged', sha: targetSha, sourceBranch, expectedSha, targetBranch: goal.branch, goal };
  }
  if (goal.status !== 'created') throw new Error('Goal cannot integrate new work');
  const task = new TaskRunner(cwd).listTaskStateItems().find((item) => item.name === taskName);
  if (task === undefined || task.status === 'pending' || task.status === 'running') throw new Error('Task has not ended');
  const purpose = task.goalPurpose;
  if (purpose === undefined) throw new Error('Task has no saved work purpose');
  const result = await mergeGoalBranch(cwd, expectedSha, goal.branch, signal);
  let saved = goal;
  if (result.status === 'merged') {
    saved = await store.update(goalId, (current) => appendGoalNotification(appendGoalWorkLog(current, {
      summary: `Integrated ${taskName} (${expectedSha}) into ${goal.branch}: ${purpose}`,
    }), { kind: 'progress', body: formatIntegratedWorkNotification(purpose, language) }, notifications));
  }
  return { ...result, sourceBranch, expectedSha, targetBranch: goal.branch, goal: saved };
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function completionRecord(
  goal: Goal, expectedSha: string, targetBranch: string, summary: string,
  changeSummary: NonNullable<Goal['completion']>['changeSummary'], worktrees: string[],
): NonNullable<Goal['completion']> {
  const directory = worktrees[0];
  const git = directory === undefined ? 'git' : `git -C ${shellQuote(directory)}`;
  return {
    goalBranch: goal.branch, goalSha: expectedSha, targetBranch, summary, changeSummary,
    ...(worktrees.length > 0 ? { worktrees } : {}),
    instructions: [
      ...(directory === undefined
        ? ['Run in a clean worktree of this repository where switching branches is possible.'] : []),
      `${git} status --short`,
      ...(directory === undefined ? [`${git} switch ${shellQuote(targetBranch)}`] : []),
      `${git} merge --no-ff --no-edit ${shellQuote(expectedSha)}`,
    ],
  };
}

export async function completeGoal(
  cwd: string, goalId: string, expectedSha: string, summary: string,
  mainMerge: 'auto' | 'approve', signal: AbortSignal | undefined,
  notifications: GoalNotificationPolicy,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  await assertReviewedGoalSha(cwd, goal.branch, expectedSha, signal);
  if (goal.status === 'completed') return { goal };
  const targetBranch = goal.integrationBranch;
  const targetSha = await resolveGoalBranchSha(cwd, targetBranch, signal);
  const included = await isGoalCommitIncluded(cwd, expectedSha, targetSha, signal);
  if (goal.status === 'awaiting_merge' && goal.completion?.goalSha === expectedSha && !included) {
    return { status: goal.status, completion: goal.completion };
  }
  const changeSummary = await readGoalDiffSummary(cwd, targetSha, expectedSha, GOAL_DIFF_MAX_FILES, signal);
  const completion = completionRecord(goal, expectedSha, targetBranch, summary, changeSummary, []);
  const result = included ? { status: 'merged' as const, sha: targetSha }
    : mainMerge === 'auto' ? await mergeGoalBranch(cwd, expectedSha, targetBranch, signal) : undefined;
  if (result?.status === 'conflict') return result;
  if (result?.status === 'merged') {
    const saved = await store.update(goalId, (current) => appendGoalNotification({
      ...current, status: 'completed', completion: { ...completion, targetSha: result.sha },
    }, { kind: 'completed', body: summary }, notifications));
    return { ...result, completion: saved.completion, goal: saved };
  }
  const worktrees = result?.status === 'checked_out' ? result.worktrees : await targetWorktrees(cwd, targetBranch, signal);
  const waiting = {
    ...completionRecord(goal, expectedSha, targetBranch, summary, changeSummary, worktrees),
    reason: result?.status === 'checked_out' ? 'Target branch is checked out; human merge required'
      : 'Repository manager.main_merge requires human merge',
  };
  const saved = await store.update(goalId, (current) => {
    const updated: Goal = { ...current, status: 'awaiting_merge', completion: waiting };
    return current.status === 'awaiting_merge' ? updated : appendGoalNotification(updated, {
      kind: 'awaiting_merge', body: summary,
    }, notifications);
  });
  return { status: 'awaiting_merge', completion: waiting, goal: saved };
}

function runReopenGit(
  cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, acceptedCodes: readonly number[],
) {
  const result = spawnSync('git', [
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...args,
  ], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4096 });
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null || result.status === null || !acceptedCodes.includes(result.status)) {
    throw new Error(`Goal Git ${args[0]} failed (${result.signal ?? result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

function isReopenApprovalIncluded(cwd: string, goal: Goal, approvedSha: string, env: NodeJS.ProcessEnv): boolean {
  const resolved = runReopenGit(cwd, ['rev-parse', '--verify', `${toLocalBranchRef(goal.integrationBranch)}^{commit}`], env, [0]);
  const targetSha = resolved.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(targetSha)) throw new Error('Goal Git returned an incomplete target SHA');
  return runReopenGit(cwd, ['merge-base', '--is-ancestor', approvedSha, targetSha], env, [0, 1]).status === 0;
}

export async function reopenGoal(
  cwd: string, goalId: string, reason: string, signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  if (goal.status !== 'awaiting_merge' || goal.completion === undefined) throw new Error('Goal is not awaiting a human merge');
  const approvedSha = goal.completion.goalSha;
  const targetSha = await resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
  if (await isGoalCommitIncluded(cwd, approvedSha, targetSha, signal)) {
    throw new Error('Approved goal SHA is already included in the target branch. Use takt_check_goal_completion.');
  }
  signal?.throwIfAborted();
  const env = await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false });
  const saved = await store.update(goalId, (current) => {
    signal?.throwIfAborted();
    if (current.status !== 'awaiting_merge') throw new Error('Goal is not awaiting a human merge');
    if (current.completion?.goalSha !== approvedSha) {
      throw new Error('Approved goal SHA changed during the reopen check. Use takt_check_goal_completion.');
    }
    // 保存ロックを保持したまま、ロック待機中の対象ブランチ更新も確認する。
    const included = isReopenApprovalIncluded(cwd, current, approvedSha, env);
    signal?.throwIfAborted();
    if (included) {
      throw new Error('Approved goal SHA is already included in the target branch. Use takt_check_goal_completion.');
    }
    return appendGoalWorkLog({ ...current, status: 'created' }, { summary: reason });
  });
  return { goal: saved, workLogEntryId: saved.workLog.at(-1)!.id };
}

export async function checkGoalCompletion(
  cwd: string, goalId: string, signal: AbortSignal | undefined, notifications: GoalNotificationPolicy,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  if (goal.status === 'completed') return { included: true, goal };
  if (goal.status !== 'awaiting_merge' || goal.completion === undefined) throw new Error('Goal is not awaiting a human merge');
  const targetSha = await resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
  const included = await isGoalCommitIncluded(cwd, goal.completion.goalSha, targetSha, signal);
  if (!included) return { included: false, goal };
  const completion = { ...goal.completion, targetBranch: goal.integrationBranch, targetSha };
  const saved = await store.update(goalId, (current) => appendGoalNotification({
    ...current, status: 'completed', completion,
  }, { kind: 'completed', body: completion.summary }, notifications));
  return { included: true, targetSha, goal: saved };
}
