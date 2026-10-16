import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { TaskRunner } from '../../infra/task/index.js';
import { issueTellableRunningTask, resolveTellableRunningTask } from '../tasks/liveIntervention.js';
import { goalTellSummary } from './goalResponse.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { TellGoalRunInput } from './schemas.js';

export function tellTaktGoalRun(input: TellGoalRunInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const task = new TaskRunner(input.cwd).listTaskStateItems().find((item) => item.name === input.taskName);
    if (task === undefined || task.goalId !== input.goalId) throw new Error('Task does not belong to this goal');
    if (task.kind !== 'running') throw new Error('Goal task is not running');
    if (task.runSlug === undefined) throw new Error('Goal task has no run slug');
    const target = resolveTellableRunningTask(input.cwd, task.runSlug);
    if (target.task.name !== task.name || target.task.goalId !== input.goalId) {
      throw new Error('Run does not belong to this goal task');
    }
    signal.throwIfAborted();
    const result = await issueTellableRunningTask(input.cwd, task.runSlug, input.content);
    let workLogEntryId: string;
    try {
      const saved = await new GoalStore(input.cwd).update(input.goalId, (current) => appendGoalWorkLog(current, {
        summary: input.content,
      }));
      workLogEntryId = saved.workLog.at(-1)!.id;
    } catch (error) {
      throw new Error(`Instruction ${result.instructionId} was issued, but saving the goal work log failed`, { cause: error });
    }
    return goalTellSummary(input.goalId, task.name, result.target.runSlug, result.instructionId, workLogEntryId);
  }, 'Goal run tell failed', 'tell');
}
