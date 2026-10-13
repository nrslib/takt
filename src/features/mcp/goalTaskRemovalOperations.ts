import { join } from 'node:path';
import { GoalStore } from '../../infra/goals/store.js';
import type { Goal } from '../../infra/goals/schema.js';
import { withGoalExecutionLock } from '../../infra/goals/execution-lock.js';
import { finishGoalOperation, validateGoalOperation } from '../../infra/goals/operations.js';
import { readGoalTaskRemovalRecovery, recordGoalTaskRemoval, type GoalTaskRemovalRecovery } from '../../infra/goals/taskRemoval.js';
import { TaskRunner } from '../../infra/task/runner.js';
import type { TaskState } from '../../infra/task/types.js';
import { deleteTaskResources } from '../tasks/list/taskDeleteActions.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { RemoveGoalTaskInput } from './goalTaskRemovalSchemas.js';

function validateTarget(goal: Goal, taskName: string, target: TaskState | undefined) {
  if (target === undefined || target.goalId !== goal.id) throw new Error('Task does not belong to this goal');
  const unit = goal.workUnits?.find((item) => item.taskName === taskName);
  if (unit === undefined) throw new Error('Task has no work unit in this goal');
  if (target.status === 'running') throw new Error('Cannot remove a running task');
  if (target.status === 'completed' && unit.integration?.status !== 'merged') {
    throw new Error('Completed task has not been merged into the goal');
  }
  if (target.status === 'pending' && (goal.status !== 'created' || goal.executionStatus !== 'active')) {
    throw new Error('Pending tasks can only be cancelled for an active goal');
  }
  return { ...target, status: target.status };
}

function validatePreparedTarget(goal: Goal, target: TaskState | undefined, saved: GoalTaskRemovalRecovery) {
  const eligible = validateTarget(goal, saved.taskName, target);
  if (eligible.status !== saved.taskStatus) throw new Error('Task status changed since removal was prepared');
  if (eligible.branch !== saved.resources.branch || eligible.worktreePath !== saved.resources.worktreePath) {
    throw new Error('Task resources changed since removal was prepared');
  }
  return eligible;
}

export function removeTaktGoalTask(
  input: RemoveGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal,
) {
  return goalWrite(input, deps, signal, async (_policy, _mainMerge, operation) => {
    if (operation === undefined) throw new Error('Removal requires a saved operation');
    const store = new GoalStore(input.cwd);
    const goal = await store.get(input.goalId);
    const runner = new TaskRunner(input.cwd);
    const target = runner.listTaskStateItems().find((task) => task.name === input.taskName);
    const recovery = operation.recovery === undefined ? undefined : readGoalTaskRemovalRecovery(goal, operation);
    const saved: GoalTaskRemovalRecovery = await validateGoalOperation(store, goal.id, operation, signal, async () => {
      signal.throwIfAborted();
      if (recovery !== undefined) {
        if (!goal.workUnits?.some((unit) => unit.taskName === input.taskName)) {
          throw new Error('Task has no work unit in this goal');
        }
        if (target === undefined) return recovery;
      }
      const eligible = validateTarget(goal, input.taskName, target);
      if (recovery !== undefined && eligible.status !== recovery.taskStatus) {
        throw new Error('Task status changed since removal was prepared');
      }
      return recovery ?? {
        goalId: goal.id, taskName: input.taskName, taskStatus: eligible.status,
        resources: { branch: eligible.branch, worktreePath: eligible.worktreePath },
        result: { taskName: input.taskName, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), status: 'removed' as const },
        record: { kind: eligible.status === 'pending' ? 'cancel' as const : 'cleanup' as const,
          reason: input.reason, recordedAt: operation.recordedAt, operationId: operation.id },
      };
    });
    if (recovery === undefined) await store.update(goal.id, (current) => {
      signal.throwIfAborted();
      validatePreparedTarget(current, runner.listTaskStateItems().find((task) => task.name === input.taskName), saved);
      const operations = current.operations?.some((item) => item.id === operation.id)
        ? current.operations : [...(current.operations ?? []), operation];
      return { ...current, operations: operations.map((item) => item.id === operation.id ? { ...item, recovery: saved } : item) };
    });
    signal.throwIfAborted();
    withGoalExecutionLock(input.cwd, () => {
      signal.throwIfAborted();
      const currentTarget = runner.listTaskStateItems().find((task) => task.name === input.taskName);
      // 削除後の公開失敗は、事前に保存された同一操作の recovery から記録だけ復旧する。
      if (currentTarget === undefined && recovery !== undefined) return;
      const eligible = validatePreparedTarget(store.getSync(goal.id), currentTarget, saved);
      const task = runner.listAllTaskItems().find((item) => item.name === input.taskName);
      if (task === undefined || task.kind !== eligible.status) throw new Error('Task is not available for removal');
      if (!deleteTaskResources(task, { quiet: true, resume: recovery !== undefined, requireCleanupSuccess: true })) {
        throw new Error('Task branch cleanup failed');
      }
    });
    await store.update(goal.id, (current) => finishGoalOperation(
      recordGoalTaskRemoval(current, input.taskName, saved.record), operation, saved.result,
    ));
    return saved.result;
  }, 'Goal task removal failed', 'remove');
}
