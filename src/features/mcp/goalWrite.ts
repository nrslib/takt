import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import type { GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../manager/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { GetGoalInput } from './schemas.js';
import { beginGoalOperation, withGoalWrites } from '../../infra/goals/operations.js';
import type { GoalOperation } from '../../infra/goals/schema.js';

export async function goalWrite(
  input: GetGoalInput & { operationName?: string }, deps: McpOperationDependencies, signal: AbortSignal,
  action: (policy: GoalNotificationPolicy, mainMerge: 'auto' | 'approve', operation: GoalOperation | undefined) => Promise<Record<string, unknown>>,
  errorContext: string, tool: GoalOperation['tool'],
) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await store.get(input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], () => withGoalWrites(input.cwd, input.goalId, async () => {
      const previous = await store.get(input.goalId);
      const context = deps.goalEventContext;
      if (context !== undefined && context.goalId !== input.goalId) throw new Error('Operation belongs to another goal');
      const args = Object.fromEntries(Object.entries(input).filter(([key]) => !['cwd', 'goalId', 'operationName'].includes(key)));
      const operation = context === undefined ? undefined : await beginGoalOperation(store, context, input.operationName, tool, args);
      if (operation?.status === 'completed') return jsonResult(operation.result!);
      const { policy, webhookUrl, mainMerge } = resolveManagerNotificationOptions(input.cwd);
      const result = await action(policy, mainMerge, operation);
      if (result.recorded !== false) {
        await sendSavedGoalNotifications(input.cwd, previous, await store.get(input.goalId), webhookUrl);
      }
      return jsonResult(result, result.recorded === false);
    }), deps.goalTurnOwners, signal);
  } catch (error) { return errorResult(errorContext, error); }
}
