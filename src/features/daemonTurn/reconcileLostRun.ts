import type { WatchObservation } from '../../core/daemon/events.js';
import { TaskStore } from '../../infra/task/store.js';
import { getTaskProcessIdentity } from '../../infra/task/taskProcessIdentity.js';
import { withGoalExecutionLock } from '../../infra/goals/execution-lock.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import type { GoalTaskResult } from '../../infra/goals/schema.js';

function recordedProcessLost(pid: number, startTime: string): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  const actual = getTaskProcessIdentity(pid);
  return actual !== undefined && actual.startTime !== startTime;
}

export function reconcileLostRun(observation: Extract<WatchObservation, { kind: 'run_process_lost' }>, signal: AbortSignal): boolean {
  const { task: reference } = observation;
  const failureReason = 'Execution process stopped before saving its result';
  const result: GoalTaskResult = { success: false, interrupted: true, workflowResult: 'error', failureReason,
    shaUnavailableReason: failureReason };
  let recovered = false;
  withGoalExecutionLock(reference.repositoryDirectory, () => {
    new TaskStore(reference.repositoryDirectory).update((current) => {
      signal.throwIfAborted();
      const task = current.tasks.find((task) => task.name === reference.taskName);
      if (task === undefined || task.status !== 'running' || task.goal_id !== reference.goalId || task.run_slug !== reference.runSlug
        || task.execution_id !== reference.executionId || task.owner_pid !== observation.pid || task.owner_start_time !== observation.startTime
        || !recordedProcessLost(observation.pid, observation.startTime)) return undefined;
      recovered = true;
      return { tasks: current.tasks.map((value) => value !== task ? value : {
        ...value, status: 'failed' as const, completed_at: new Date().toISOString(), owner_pid: null, owner_start_time: null,
        failure: { error: failureReason }, completion: result,
      }) };
    });
  });
  if (recovered) saveManagerEvent(reference.repositoryDirectory, { kind: 'completion', goalId: reference.goalId,
    taskName: reference.taskName, runSlug: reference.runSlug, result });
  return recovered;
}
