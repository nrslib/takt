import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import type { McpOperationDependencies } from './operations.js';
import type { NotifyGoalInput } from './schemas.js';
import { goalWrite } from './goalWrite.js';

export function notifyTaktGoal(input: NotifyGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy) => ({
    goal: await new GoalStore(input.cwd).update(input.goalId, (current) => appendGoalNotification(current, {
      kind: input.kind, body: input.body, severity: input.severity,
    }, policy)),
  }), 'Goal notification failed');
}
