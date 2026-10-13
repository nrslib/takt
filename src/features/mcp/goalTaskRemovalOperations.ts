import { join } from 'node:path';
import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { isGoalCommitIncluded, resolveGoalBranchSha } from '../../infra/goals/git-command.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { deleteTaskResources } from '../tasks/list/taskDeleteActions.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { RemoveGoalTaskInput } from './goalTaskRemovalSchemas.js';

export function removeTaktGoalTask(input: RemoveGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const store = new GoalStore(input.cwd);
    const goal = await store.get(input.goalId);
    const runner = new TaskRunner(input.cwd);
    const target = runner.listTaskStateItems().find((task) => task.name === input.taskName);
    const result = { taskName: input.taskName, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), status: 'removed' };
    if (target === undefined) return result;
    if (target.goalId !== goal.id) throw new Error('Task does not belong to this goal');
    if (target.status === 'running') throw new Error('Cannot remove a running task');
    if (target.status === 'completed') {
      const sha = target.completion?.sha;
      const goalSha = await resolveGoalBranchSha(input.cwd, goal.branch, signal);
      if (sha === undefined || !await isGoalCommitIncluded(input.cwd, sha, goalSha, signal)) {
        throw new Error('Completed task has not been merged into the goal');
      }
    }
    if (target.status === 'pending' && (goal.status !== 'created' || goal.executionStatus !== 'active')) {
      throw new Error('Pending tasks can only be cancelled for an active goal');
    }
    signal.throwIfAborted();
    const task = runner.listAllTaskItems().find((item) => item.name === input.taskName);
    if (task === undefined || task.kind !== target.status) throw new Error('Task is not available for removal');
    if (!deleteTaskResources(task, { quiet: true, requireCleanupSuccess: true })) throw new Error('Task branch cleanup failed');
    await store.update(goal.id, (current) => appendGoalWorkLog(current, {
      summary: `Removed ${input.taskName}: ${input.reason}`,
    }));
    return result;
  }, 'Goal task removal failed', 'remove');
}
