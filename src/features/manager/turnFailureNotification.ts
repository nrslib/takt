import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { appendGoalNotification, managerTurnFailureNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { basename } from 'node:path';
import { sendSlackNotification } from '../../shared/utils/slackWebhook.js';
import { getLabel } from '../../shared/i18n/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from './notifications.js';

const log = createLogger('manager-turn-failure-notification');

export async function notifyManagerTurnFailure(cwd: string, goalId: string | undefined, error: unknown, operationId?: string): Promise<string | undefined> {
  try {
    const { policy, webhookUrl } = resolveManagerNotificationOptions(cwd);
    if (!policy.blocked) return;
    const language = resolveConfigValue(cwd, 'language');
    const reason = sanitizeSensitiveText(getErrorMessage(error));
    if (goalId === undefined) {
      const message = [
        getLabel('manager.notificationHeadings.blocked', language, { project: basename(cwd) }),
        getLabel('manager.conversationFailureNotification', language, { reason }),
      ].join('\n');
      if (webhookUrl) await sendSlackNotification(webhookUrl, message);
      return message;
    }
    const notification = managerTurnFailureNotification(goalId, error, language);
    let previous: Goal | undefined;
    const saved = await new GoalStore(cwd).update(goalId, (current) => {
      if (operationId !== undefined && current.notifications?.some((notice) => notice.id === operationId)) return current;
      previous = current;
      return appendGoalNotification(current, notification, policy, operationId);
    });
    if (previous !== undefined) await sendSavedGoalNotifications(cwd, previous, saved, webhookUrl);
  } catch (notificationError) {
    const reason = sanitizeSensitiveText(getErrorMessage(notificationError));
    log.error('Failed to notify manager turn failure', { goalId, error: reason });
  }
  return undefined;
}
