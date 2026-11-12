import { createHash } from 'node:crypto';
import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import type { McpOperationDependencies } from './operations.js';
import type { NotifyGoalInput } from './schemas.js';
import { goalWrite } from './goalWrite.js';
import { goalWriteSummary } from './goalResponse.js';

function turnNotificationId(input: NotifyGoalInput, operationId: string | undefined): string | undefined {
  if (operationId === undefined) return undefined;
  const bytes = createHash('sha256')
    .update(JSON.stringify([operationId, input.kind, input.body, input.severity ?? null]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function notifyTaktGoal(input: NotifyGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async ({ policy }) => {
    const id = turnNotificationId(input, deps.turnOperationId);
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) =>
      id !== undefined && current.notifications?.some((notification) => notification.id === id)
        ? current
        : appendGoalNotification(current, { kind: input.kind, body: input.body, severity: input.severity }, policy, id));
    const notification = id === undefined
      ? goal.notifications?.at(-1)
      : goal.notifications?.find((saved) => saved.id === id);
    return { goal: goalWriteSummary(goal), notificationId: policy[input.kind] ? notification?.id ?? null : null };
  }, 'Goal notification failed', 'notify');
}
