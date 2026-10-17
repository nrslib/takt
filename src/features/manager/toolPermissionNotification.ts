import { basename } from 'node:path';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { sendSlackNotification } from '../../shared/utils/slackWebhook.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from './notifications.js';
import type { ManagerPermissionGoal } from './toolPermissionJudge.js';

const log = createLogger('manager-tool-permission-notification');

export async function notifyManagerToolPermission(input: {
  cwd: string; goal?: ManagerPermissionGoal; message: string;
}): Promise<string | undefined> {
  let displayMessage: string | undefined;
  try {
    const directory = input.goal?.repositoryDirectory ?? input.cwd;
    const { policy, webhookUrl } = resolveManagerNotificationOptions(directory);
    if (!policy.custom) return undefined;
    const body = sanitizeSensitiveText(input.message);
    if (input.goal === undefined) {
      displayMessage = `${basename(directory)}: ${body}`;
      if (webhookUrl) await sendSlackNotification(webhookUrl, displayMessage);
    } else {
      let previous: Goal | undefined;
      const saved = await new GoalStore(directory).update(input.goal.id, (current) => {
        previous = current;
        return appendGoalNotification(current, { kind: 'custom', severity: 'warning', body }, policy);
      });
      if (previous !== undefined) await sendSavedGoalNotifications(directory, previous, saved, webhookUrl);
    }
  } catch (error) {
    log.error('Failed to notify manager tool permission', { error: sanitizeSensitiveText(getErrorMessage(error)) });
  }
  return displayMessage;
}
