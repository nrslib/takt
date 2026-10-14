import { TaskRunner } from '../task/runner.js';
import { GoalStore } from './store.js';
import type { Goal } from './schema.js';
import { mergeGoalBranch, targetWorktrees } from './merge-git.js';
import { isGoalCommitIncluded, resolveGoalBranchSha } from './git-command.js';
import { GOAL_DIFF_MAX_FILES, readGoalDiffSummary } from './diff-summary.js';
import { appendGoalNotification, formatIntegratedWorkNotification, type GoalNotificationPolicy } from './notifications.js';
import { appendGoalWorkLog } from './workLog.js';
import type { Language } from '../../core/models/types.js';

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
