import { GoalStore } from '../../infra/goals/store.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import type { GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../manager/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import {
  askGoalQuestionInputSchema, completeGoalInputSchema, enqueueGoalTaskInputSchema, goalWriteInputSchema,
  mergeGoalTaskInputSchema, notifyGoalInputSchema, withdrawGoalQuestionInputSchema, type GetGoalInput,
} from './schemas.js';
import { prepareGoalOperation, withGoalWrites } from '../../infra/goals/operations.js';
import type { GoalOperation } from '../../infra/goals/schema.js';

const inputSchemas = {
  enqueue: enqueueGoalTaskInputSchema, integrate: mergeGoalTaskInputSchema, complete: completeGoalInputSchema,
  question: askGoalQuestionInputSchema, notify: notifyGoalInputSchema,
  withdraw_question: withdrawGoalQuestionInputSchema, check_completion: goalWriteInputSchema,
};

export async function goalWrite(
  input: GetGoalInput & { operationName?: string }, deps: McpOperationDependencies, signal: AbortSignal,
  action: (policy: GoalNotificationPolicy, mainMerge: 'auto' | 'approve', operation: GoalOperation | undefined) => Promise<Record<string, unknown>>,
  errorContext: string, tool: GoalOperation['tool'],
) {
  try {
    inputSchemas[tool].parse(input);
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await store.get(input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], () => withGoalWrites(input.cwd, input.goalId, async () => {
      const previous = await store.get(input.goalId);
      if (isGoalPaused(previous) && ['enqueue', 'integrate', 'complete', 'check_completion'].includes(tool)) {
        throw new Error('Goal is paused. Ask the human to resume it with /resume <goalId> in the manager TUI before continuing work.');
      }
      const context = deps.goalEventContext;
      if (context !== undefined && context.goalId !== input.goalId) throw new Error('Operation belongs to another goal');
      const args = Object.fromEntries(Object.entries(input).filter(([key]) => !['cwd', 'goalId', 'operationName'].includes(key)));
      const operation = context === undefined ? undefined : prepareGoalOperation(previous, context, input.operationName, tool, args);
      if (operation?.status === 'completed') return jsonResult(operation.result!);
      if (operation?.status === 'failed') return jsonResult(operation.result!, true);
      const { policy, webhookUrl, mainMerge } = resolveManagerNotificationOptions(input.cwd);
      let result: Record<string, unknown>;
      try { result = await action(policy, mainMerge, operation); }
      catch (error) {
        try {
          const saved = operation === undefined ? undefined
            : (await store.get(input.goalId)).operations?.find((item) => item.id === operation.id);
          if (saved?.status === 'failed') return jsonResult(saved.result!, true);
        } catch {
          // 保存結果の照合に失敗しても、元のアクションのエラーを優先する。
          throw error;
        }
        throw error;
      }
      if (result.recorded !== false) {
        await sendSavedGoalNotifications(input.cwd, previous, await store.get(input.goalId), webhookUrl);
      }
      return jsonResult(result, result.recorded === false);
    }), deps.goalTurnOwners, signal);
  } catch (error) { return errorResult(errorContext, error); }
}
