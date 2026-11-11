import { basename } from 'node:path';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { formatGoalNotification, formatStandaloneQuestionNotification, type GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';
import { getSlackWebhookUrl, sendSlackNotification } from '../../shared/utils/slackWebhook.js';
import { escapeSlackMentions } from '../../shared/utils/slackText.js';
import { getLabel } from '../../shared/i18n/index.js';

export function resolveManagerNotificationOptions(cwd: string): {
  policy: GoalNotificationPolicy; webhookUrl: string | undefined; mainMerge: 'auto' | 'approve';
} {
  const config = resolveManagerConfig(cwd);
  return { policy: config.notifications, mainMerge: config.mainMerge, webhookUrl: getSlackWebhookUrl() };
}

export async function sendSavedStandaloneQuestionNotification(cwd: string, question: GoalQuestion): Promise<void> {
  const { policy, webhookUrl } = resolveManagerNotificationOptions(cwd);
  if (!policy.question || !webhookUrl) return;
  const language = resolveConfigValue(cwd, 'language');
  await sendSlackNotification(webhookUrl, formatStandaloneQuestionNotification(question, language, basename(cwd)));
}

export async function sendSavedGoalNotifications(
  cwd: string, previous: Goal, current: Goal, webhookUrl: string | undefined,
): Promise<void> {
  if (!webhookUrl) return;
  const language = resolveConfigValue(cwd, 'language');
  const project = basename(cwd);
  const turnFailurePrefix = getLabel('manager.turnFailureNotification', language).split('\n')[0]!;
  const sent = new Set(previous.notifications?.map((notification) => notification.id));
  for (const notification of current.notifications ?? []) {
    if (sent.has(notification.id)) continue;
    const message = formatGoalNotification(current, notification, language, project);
    const turnFailure = notification.kind === 'blocked' && notification.severity === 'error'
      && notification.body.startsWith(turnFailurePrefix);
    await sendSlackNotification(webhookUrl, turnFailure
      ? escapeSlackMentions(message) : message);
  }
}
