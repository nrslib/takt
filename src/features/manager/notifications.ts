import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { formatGoalNotification, type GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import { recordManagerRunFailure } from '../../infra/task/manager-run-state.js';
import { getSlackWebhookUrl, sendSlackNotification } from '../../shared/utils/slackWebhook.js';

export function resolveManagerNotificationOptions(cwd: string): {
  policy: GoalNotificationPolicy; webhookUrl: string | undefined; mainMerge: 'auto' | 'approve';
} {
  const config = resolveManagerConfig(cwd);
  return { policy: config.notifications, mainMerge: config.mainMerge, webhookUrl: getSlackWebhookUrl() };
}

export async function sendSavedGoalNotifications(
  cwd: string, previous: Goal, current: Goal, webhookUrl: string | undefined,
): Promise<void> {
  if (!webhookUrl) return;
  const sent = new Set(previous.notifications?.map((notification) => notification.id));
  for (const notification of current.notifications ?? []) {
    if (sent.has(notification.id)) continue;
    await sendSlackNotification(webhookUrl, formatGoalNotification(current, notification),
      (message) => recordManagerRunFailure(cwd, new Error(`${current.id}: ${message}`)));
  }
}
