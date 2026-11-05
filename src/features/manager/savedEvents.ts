import { basename } from 'node:path';
import type { Language } from '../../core/models/types.js';
import type { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { formatGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';

type ManagerNotificationPolicy = Readonly<ReturnType<typeof resolveManagerConfig>['notifications']>;

export type ManagerDisplayGoal = Pick<Goal, 'id' | 'objective' | 'status' | 'executionStatus'>;
export interface ManagerDisplayEvent {
  id: string;
  message: string;
}

export function* projectManagerDisplayEvents(goal: Goal, directory: string, language: Language,
  notificationStartedAt: number, policy: ManagerNotificationPolicy): Generator<ManagerDisplayEvent> {
  const project = basename(directory);
  for (const notification of goal.notifications ?? []) {
    if (notification.kind === 'question' || !policy[notification.kind]) continue;
    if (Date.parse(notification.recordedAt) < notificationStartedAt) continue;
    yield { id: JSON.stringify([directory, goal.id, 'notification', notification.id]),
      message: formatGoalNotification(goal, notification, language, project, 'tui') };
  }
}
