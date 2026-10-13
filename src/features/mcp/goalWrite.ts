import { GoalStore } from '../../infra/goals/store.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import type { GoalNotificationPolicy } from '../../infra/goals/notifications.js';
import { resolveManagerNotificationOptions, sendSavedGoalNotifications } from '../manager/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import {
  askGoalQuestionInputSchema, completeGoalInputSchema, enqueueGoalTaskInputSchema, goalWriteInputSchema,
  mergeGoalTaskInputSchema, notifyGoalInputSchema, withdrawGoalQuestionInputSchema, type GetGoalInput,
} from './schemas.js';
import { requeueGoalTaskInputSchema, retryGoalTaskInputSchema } from './goalTaskRetrySchemas.js';
import { removeGoalTaskInputSchema } from './goalTaskRemovalSchemas.js';

const inputSchemas = {
  enqueue: enqueueGoalTaskInputSchema, integrate: mergeGoalTaskInputSchema, complete: completeGoalInputSchema,
  question: askGoalQuestionInputSchema, notify: notifyGoalInputSchema,
  withdraw_question: withdrawGoalQuestionInputSchema, check_completion: goalWriteInputSchema,
  requeue: requeueGoalTaskInputSchema, retry: retryGoalTaskInputSchema, remove: removeGoalTaskInputSchema,
};

export async function goalWrite(
  input: GetGoalInput, deps: McpOperationDependencies, signal: AbortSignal,
  action: (policy: GoalNotificationPolicy, mainMerge: 'auto' | 'approve') => Promise<Record<string, unknown>>,
  errorContext: string, tool: keyof typeof inputSchemas,
) {
  try {
    inputSchemas[tool].parse(input);
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    const previous = await store.get(input.goalId);
    signal.throwIfAborted();
    if (previous.executionStatus === 'aborted' && tool !== 'withdraw_question' && tool !== 'remove') {
      throw new Error('Goal is aborted. Work cannot continue for this goal.');
    }
    if (isGoalPaused(previous) && ['enqueue', 'integrate', 'complete', 'check_completion', 'requeue', 'retry'].includes(tool)) {
      throw new Error('Goal is paused. Resume it in the manager TUI before continuing work.');
    }
    const { policy, webhookUrl, mainMerge } = resolveManagerNotificationOptions(input.cwd);
    const result = await action(policy, mainMerge);
    await sendSavedGoalNotifications(input.cwd, previous, await store.get(input.goalId), webhookUrl);
    return jsonResult(result);
  } catch (error) { return errorResult(errorContext, error); }
}
