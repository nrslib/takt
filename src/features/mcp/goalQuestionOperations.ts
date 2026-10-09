import { GoalStore } from '../../infra/goals/store.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../../infra/goals/questions.js';
import { appendGoalNotification } from '../../infra/goals/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { AskGoalQuestionInput, GetGoalQuestionInput, GetGoalInput } from './schemas.js';

export function askTaktGoalQuestion(input: AskGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async (policy) => {
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => {
      const added = addGoalQuestion(current, {
        body: input.body, options: input.options, recommendation: input.recommendation,
        dependentWorkKeys: input.dependentWorkKeys,
      });
      return appendGoalNotification(added.goal, {
        kind: 'question',
        body: `${added.questionId}: ${input.body}${input.options === undefined ? '' : `\nOptions: ${input.options.join(', ')}`}${input.recommendation === undefined ? '' : `\nRecommendation: ${input.recommendation}`}`,
      }, policy);
    });
    return { questionId: goal.questions![goal.questions!.length - 1]!.id };
  }, 'Goal question failed');
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
  return goalWrite(input, deps, signal, async () => ({
    goal: await new GoalStore(input.cwd).update(input.goalId, (current) => withdrawGoalQuestion(current, input.questionId)),
  }), 'Goal question withdrawal failed');
}
