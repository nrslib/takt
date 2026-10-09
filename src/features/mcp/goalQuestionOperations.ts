import { GoalStore } from '../../infra/goals/store.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../../infra/goals/questions.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../../infra/goals/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { AskGoalQuestionInput, GetGoalQuestionInput, GetGoalInput } from './schemas.js';
import { finishGoalOperation } from '../../infra/goals/operations.js';

export function askTaktGoalQuestion(input: AskGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy, _mainMerge, operation) => {
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => {
      const added = addGoalQuestion(current, {
        body: input.body, options: input.options, recommendation: input.recommendation,
        dependentWorkKeys: input.dependentWorkKeys,
        recipient: input.recipient,
      });
      const question = added.goal.questions!.at(-1)!;
      const notified = question.recipient === 'human' ? appendGoalNotification(added.goal, {
        kind: 'question', body: formatGoalQuestionNotification(question),
      }, policy) : added.goal;
      return finishGoalOperation(notified, operation, { questionId: added.questionId });
    });
    return { questionId: goal.questions![goal.questions!.length - 1]!.id };
  }, 'Goal question failed', 'question');
}

export async function listTaktGoalQuestions(input: GetGoalInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    return jsonResult({ questions: (await new GoalStore(input.cwd).get(input.goalId)).questions ?? [] });
  } catch (error) { return errorResult('Goal question read failed', error); }
}

export async function getTaktGoalQuestion(input: GetGoalQuestionInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const question = (await new GoalStore(input.cwd).get(input.goalId)).questions?.find((saved) => saved.id === input.questionId);
    if (question === undefined) throw new Error('Question does not exist');
    return jsonResult({ question });
  } catch (error) { return errorResult('Goal question read failed', error); }
}

export function withdrawTaktGoalQuestion(input: GetGoalQuestionInput & { operationName?: string }, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (_policy, _mainMerge, operation) => {
    const result = { questionId: input.questionId, status: 'withdrawn' };
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => finishGoalOperation(
      withdrawGoalQuestion(current, input.questionId), operation, result,
    ));
    return operation === undefined ? { goal } : result;
  }, 'Goal question withdrawal failed', 'withdraw_question');
}
