import { randomUUID } from 'node:crypto';
import type { ManagerNotificationKind } from '../../core/models/config-types.js';
import { GoalNotificationInputSchema, type Goal, type GoalNotificationInput } from './schema.js';

export type GoalNotificationPolicy = Record<ManagerNotificationKind, boolean>;

export function appendGoalNotification(goal: Goal, input: GoalNotificationInput, policy: GoalNotificationPolicy): Goal {
  if (!policy[input.kind]) return goal;
  const notification = {
    ...GoalNotificationInputSchema.parse(input), id: randomUUID(), recordedAt: new Date().toISOString(),
  };
  if (goal.notifications?.some((saved) => saved.id === notification.id)) throw new Error('Notification ID already exists');
  return { ...goal, notifications: [...(goal.notifications ?? []), notification] };
}

export function formatGoalNotification(goal: Goal, notification: GoalNotificationInput): string {
  return `TAKT Goal ${goal.id}: ${goal.objective}\n${notification.kind}${notification.severity === undefined ? '' : ` (${notification.severity})`}\n${notification.body}`;
}
