import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import type { GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../manager/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { GetGoalInput } from './schemas.js';

export async function goalWrite(
  input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal,
  action: (policy: GoalNotificationPolicy, mainMerge: 'auto' | 'approve') => Promise<Record<string, unknown>>,
  errorContext: string,
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await store.get(input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], async () => {
      const previous = await store.get(input.goalId);
      const { policy, webhookUrl, mainMerge } = resolveManagerNotificationOptions(input.cwd);
      const result = await action(policy, mainMerge);
      if (result.recorded !== false) {
        await sendSavedGoalNotifications(input.cwd, previous, await store.get(input.goalId), webhookUrl);
      }
      return jsonResult(result, result.recorded === false);
    }, deps.goalTurnOwners, signal);
  } catch (error) { return errorResult(errorContext, error); }
}
