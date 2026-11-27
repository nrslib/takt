import { TaskRunner } from '../../infra/task/runner.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { StopGoalTaskInput } from './goalTaskStopSchemas.js';

export function stopTaktGoalTask(input: StopGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    signal.throwIfAborted();
    const request = new TaskRunner(input.cwd).requestTaskStop(input.goalId, input.taskName, input.executionId);
    return { goalId: input.goalId, taskName: input.taskName, executionId: request.execution_id,
      requestedAt: request.requested_at, status: 'stop_requested' };
  }, 'Goal task stop failed', 'stop');
}
