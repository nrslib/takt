import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { GoalStore } from '../../infra/goals/store.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../../infra/goals/questions.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../../infra/goals/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { AskGoalQuestionInput, GetGoalQuestionInput, GetGoalInput } from './schemas.js';

export function askTaktGoalQuestion(input: AskGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy) => {
    const store = new GoalStore(input.cwd);
    const current = await store.get(input.goalId);
    const existing = current.questions?.find((question) => question.body === input.body && question.status === 'pending');
    if (existing !== undefined) return { questionId: existing.id };
    const added = addGoalQuestion(current, {
      body: input.body, options: input.options, recommendation: input.recommendation, recipient: input.recipient,
    });
    const question = added.goal.questions!.at(-1)!;
    await store.update(input.goalId, (goal) => appendGoalNotification({ ...goal, questions: added.goal.questions }, {
      kind: 'question', body: formatGoalQuestionNotification(question, resolveConfigValue(input.cwd, 'language')),
    }, policy));
    return { questionId: added.questionId };
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

export function withdrawTaktGoalQuestion(input: GetGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => withdrawGoalQuestion(current, input.questionId));
    return { goal };
  }, 'Goal question withdrawal failed', 'withdraw_question');
}
