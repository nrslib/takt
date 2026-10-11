import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal } from '../../infra/goals/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { recordManagerRunFailure } from '../../infra/task/manager-run-state.js';
import { getLabel } from '../../shared/i18n/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from './notifications.js';

const log = createLogger('manager-turn-failure-notification');

export async function notifyManagerTurnFailure(cwd: string, goalId: string, error: unknown): Promise<void> {
  try {
    const { policy, webhookUrl } = resolveManagerNotificationOptions(cwd);
    if (!policy.blocked) return;
    const language = resolveConfigValue(cwd, 'language');
    const reason = sanitizeSensitiveText(getErrorMessage(error));
    const normalizedReason = reason.replace(/\s+/g, ' ').trim();
    const body = getLabel('manager.turnFailureNotification', language, { goalId, reason });
    let previous: Goal | undefined;
    const saved = await new GoalStore(cwd).update(goalId, (current) => {
      if (current.managerTurnFailureReason === normalizedReason) return current;
      previous = current;
      return {
        ...appendGoalNotification(current, { kind: 'blocked', severity: 'error', body }, policy),
        managerTurnFailureReason: normalizedReason,
      };
    });
    if (previous !== undefined) await sendSavedGoalNotifications(cwd, previous, saved, webhookUrl);
  } catch (notificationError) {
    const reason = sanitizeSensitiveText(getErrorMessage(notificationError));
    log.error('Failed to notify manager turn failure', { goalId, error: reason });
    // 通知障害の診断保存にも失敗しても、元のターン失敗を優先する。
    try { recordManagerRunFailure(cwd, new Error(reason)); }
    catch (diagnosticError) {
      log.error('Failed to record notification failure', { goalId, error: sanitizeSensitiveText(getErrorMessage(diagnosticError)) });
    }
  }
}
