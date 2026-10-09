import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import type { McpOperationDependencies } from './operations.js';
import type { NotifyGoalInput } from './schemas.js';
import { goalWrite } from './goalWrite.js';
import { finishGoalOperation } from '../../infra/goals/operations.js';

export function notifyTaktGoal(input: NotifyGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge, operation) => {
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => {
      const updated = appendGoalNotification(current, { kind: input.kind, body: input.body, severity: input.severity }, policy);
      const result = { notificationId: updated.notifications?.length === current.notifications?.length
        ? null : updated.notifications?.at(-1)?.id ?? null };
      return finishGoalOperation(updated, operation, result);
    });
    return operation === undefined ? { goal } : goal.operations!.find((saved) => saved.id === operation.id)!.result!;
  }, 'Goal notification failed', 'notify');
}
