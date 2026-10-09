import { TaskRunner } from '../task/runner.js';
import { GoalStore } from './store.js';
import { GoalCompletionSchema, type Goal, type GoalOperation } from './schema.js';
import { finishGoalOperation, saveGoalOperationRecovery } from './operations.js';
import { z } from 'zod/v4';
import { mergeGoalBranch, targetWorktrees, type GoalMergeResult } from './merge-git.js';
import { isGoalCommitIncluded, resolveGoalBranchSha } from './git-command.js';
import { GOAL_DIFF_MAX_FILES, readGoalDiffSummary } from './diff-summary.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { appendGoalNotification, type GoalNotificationPolicy } from './notifications.js';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';

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

async function saveIntegrationResult(
  store: GoalStore, id: string, transform: (current: Goal) => Goal, result: Record<string, unknown>,
  operation?: GoalOperation,
): Promise<Record<string, unknown>> {
  try {
    const savedResult = { ...result, recorded: true };
    const goal = await store.update(id, (current) => finishGoalOperation(transform(current), operation, savedResult));
    return operation === undefined ? { ...savedResult, goal } : savedResult;
  }
  catch (error) {
    return { ...result, recorded: false, recordError: safeExternalErrorMessage(error) };
  }
}

const integrationRecoverySchema = z.object({
  sourceBranch: z.string(), purpose: z.string(), workKey: z.string().optional(),
  targetBranch: z.string(), beforeSha: z.string(), recordedAt: z.iso.datetime(),
}).strict();
const completionRecoverySchema = z.object({
  completion: GoalCompletionSchema, mainMerge: z.enum(['auto', 'approve']), beforeSha: z.string(),
}).strict();

async function mergeRecordedOperation(
  cwd: string, sourceSha: string, targetBranch: string, beforeSha: string,
  recovering: boolean, signal: AbortSignal | undefined,
): Promise<GoalMergeResult> {
  if (recovering) {
    const current = await resolveGoalBranchSha(cwd, targetBranch, signal);
    if (await isGoalCommitIncluded(cwd, sourceSha, current, signal)) return { status: 'merged', sha: current };
    if (current !== beforeSha) throw new Error('Operation target changed before recovery');
  }
  return mergeGoalBranch(cwd, sourceSha, targetBranch, signal);
}

export async function integrateGoalTask(
  cwd: string, goalId: string, taskName: string, expectedSha: string, signal: AbortSignal | undefined,
  notifications: GoalNotificationPolicy, language: Language,
  operation?: GoalOperation,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  if (goal.status !== 'created') throw new Error('Goal cannot integrate new work');
  let recovery: z.infer<typeof integrationRecoverySchema>;
  if (operation?.recovery !== undefined) recovery = integrationRecoverySchema.parse(operation.recovery);
  else {
    const sourceBranch = await getGoalTaskSource(cwd, goal, taskName);
    await assertReviewedGoalSha(cwd, sourceBranch, expectedSha, signal);
    const unit = goal.workUnits?.find((item) => item.taskName === taskName);
    const task = new TaskRunner(cwd).listTaskStateItems().find((item) => item.name === taskName);
    const purpose = unit?.purpose ?? task?.goalPurpose;
    const workKey = unit?.workKey ?? task?.goalWorkKey;
    if (purpose === undefined) throw new Error('Task has no saved work purpose');
    recovery = { sourceBranch, purpose, ...(workKey === undefined ? {} : { workKey }),
      targetBranch: goal.branch, beforeSha: await resolveGoalBranchSha(cwd, goal.branch, signal), recordedAt: new Date().toISOString() };
    if (operation !== undefined) await saveGoalOperationRecovery(store, goalId, operation, recovery);
  }
  const { sourceBranch, purpose, workKey } = recovery;
  const result = operation === undefined ? await mergeGoalBranch(cwd, expectedSha, goal.branch, signal)
    : await mergeRecordedOperation(cwd, expectedSha, recovery.targetBranch, recovery.beforeSha, operation.recovery !== undefined, signal);
  const integration = {
    sourceBranch, expectedSha, status: result.status, recordedAt: recovery.recordedAt,
    ...(result.status === 'merged' ? { goalSha: result.sha }
      : result.status === 'conflict' ? { conflicts: result.conflicts } : { worktrees: result.worktrees }),
  };
  return saveIntegrationResult(store, goalId, (current) => {
    const previousIntegration = current.workUnits?.find((item) => item.taskName === taskName)?.integration;
    const alreadyIntegrated = previousIntegration?.status === 'merged' && previousIntegration.expectedSha === expectedSha;
    const updated: Goal = {
      ...current, workUnits: [
        ...(current.workUnits ?? []).filter((item) => item.taskName !== taskName),
        { taskName, purpose, integration, ...(workKey === undefined ? {} : { workKey }) },
      ],
    };
    return result.status === 'merged' && !alreadyIntegrated ? appendGoalNotification(updated, {
      kind: 'progress', body: getLabel('manager.notifyIntegrated', language, {
        task: taskName, purpose, sha: expectedSha.slice(0, 7),
      }),
    }, notifications) : updated;
  }, { ...result, sourceBranch, expectedSha, targetBranch: goal.branch }, operation);
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
  operation?: GoalOperation,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  if (operation?.recovery === undefined) await assertReviewedGoalSha(cwd, goal.branch, expectedSha, signal);
  if (operation?.recovery !== undefined && (goal.status === 'completed' || goal.status === 'awaiting_merge')) {
    if (goal.completion?.goalSha !== expectedSha) throw new Error('Saved completion does not match the reviewed SHA');
    return saveIntegrationResult(store, goalId, (current) => current, { status: goal.status, completion: goal.completion }, operation);
  }
  if (goal.status === 'completed') return operation === undefined ? { goal }
    : saveIntegrationResult(store, goalId, (current) => current, { status: 'completed', completion: goal.completion }, operation);
  let recovery: z.infer<typeof completionRecoverySchema>;
  if (operation?.recovery !== undefined) recovery = completionRecoverySchema.parse(operation.recovery);
  else {
    const comparisonSha = await resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
    const changeSummary = await readGoalDiffSummary(cwd, comparisonSha, expectedSha, GOAL_DIFF_MAX_FILES, signal);
    recovery = { completion: completionRecord(goal, expectedSha, goal.integrationBranch, summary, changeSummary, []), mainMerge, beforeSha: comparisonSha };
    if (operation !== undefined) await saveGoalOperationRecovery(store, goalId, operation, recovery);
  }
  const { targetBranch, changeSummary } = recovery.completion;
  mainMerge = recovery.mainMerge;
  let result: GoalMergeResult | undefined;
  if (mainMerge === 'auto') {
    result = operation === undefined ? await mergeGoalBranch(cwd, expectedSha, targetBranch, signal)
      : await mergeRecordedOperation(cwd, expectedSha, targetBranch, recovery.beforeSha, operation.recovery !== undefined, signal);
    if (result.status === 'conflict') {
      return operation === undefined ? result : saveIntegrationResult(store, goalId, (current) => current, result, operation);
    }
    if (result.status === 'merged') {
      const completion = recovery.completion;
      const targetSha = result.sha;
      return saveIntegrationResult(store, goalId, (current) => appendGoalNotification({
        ...current, status: 'completed', completion: { ...completion, targetSha },
      }, { kind: 'completed', body: summary }, notifications), { ...result, completion }, operation);
    }
  }
  const worktrees = result?.status === 'checked_out' ? result.worktrees
    : await targetWorktrees(cwd, targetBranch, signal);
  const waiting = {
    ...completionRecord(goal, expectedSha, targetBranch, summary, changeSummary, worktrees),
    ...(result?.status === 'checked_out'
      ? { reason: 'Target branch is checked out; human merge required' }
      : { reason: 'Repository manager.main_merge requires human merge' }),
  };
  return saveIntegrationResult(store, goalId, (current) => {
    const updated: Goal = { ...current, status: 'awaiting_merge', completion: waiting };
    return current.status === 'awaiting_merge' ? updated : appendGoalNotification(updated, {
      kind: 'awaiting_merge', body: `${summary}\n${waiting.targetBranch}: ${waiting.goalSha}\n${waiting.instructions.join('\n')}`,
    }, notifications);
  }, { status: 'awaiting_merge', completion: waiting }, operation);
}

export async function checkGoalCompletion(
  cwd: string, goalId: string, signal: AbortSignal | undefined,
  notifications: GoalNotificationPolicy,
  operation?: GoalOperation,
): Promise<Record<string, unknown>> {
  const store = new GoalStore(cwd);
  const goal = await store.get(goalId);
  if (goal.status === 'completed') return operation === undefined ? { goal }
    : saveIntegrationResult(store, goalId, (current) => current, { included: true, targetSha: goal.completion!.targetSha }, operation);
  if (goal.status !== 'awaiting_merge' || goal.completion === undefined) throw new Error('Goal is not awaiting a human merge');
  const targetSha = await resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
  const included = await isGoalCommitIncluded(cwd, goal.completion.goalSha, targetSha, signal);
  if (!included) return operation === undefined ? { included: false, goal }
    : saveIntegrationResult(store, goalId, (current) => current, { included: false }, operation);
  const completion = { ...goal.completion, targetBranch: goal.integrationBranch, targetSha };
  return saveIntegrationResult(store, goalId, (current) => appendGoalNotification({
    ...current, status: 'completed', completion,
  }, { kind: 'completed', body: completion.summary }, notifications), { included: true, targetSha }, operation);
}
