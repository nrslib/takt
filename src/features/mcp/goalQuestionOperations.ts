import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { withInquiryLock } from '../../infra/goals/inquiry-lock.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { GoalStore } from '../../infra/goals/store.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../../infra/goals/questions.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../../infra/goals/notifications.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { AskGoalQuestionInput, GetGoalQuestionInput, listGoalQuestionsInputSchema, withdrawGoalQuestionInputSchema } from './schemas.js';
import type { z } from 'zod/v4';
import { goalValuePage, selectGoalValue } from './goalResponse.js';
import { pagedResult } from './response.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

export function askTaktGoalQuestion(input: AskGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async ({ policy }) => {
    const kind = input.kind ?? 'question';
    const matches = (question: GoalQuestion) => question.body === input.body
      && question.status === 'pending' && (question.kind ?? 'question') === kind;
    const store = new GoalStore(input.cwd);
    const saved = await withInquiryLock(getGlobalConfigDir(), () => store.update(input.goalId, (current) => {
      if (current.status === 'completed') throw new Error('Goal is completed. New questions cannot be added.');
      const existing = current.questions?.find(matches);
      if (existing !== undefined) return current;
      const added = addGoalQuestion(current, {
        body: input.body, options: input.options, recommendation: input.recommendation, recipient: input.recipient,
        kind, targetSha: input.targetSha,
      });
      const question = added.goal.questions!.at(-1)!;
      return appendGoalNotification(added.goal, {
        kind: 'question', body: formatGoalQuestionNotification(question, resolveConfigValue(input.cwd, 'language')),
      }, policy);
    }));
    const question = saved.questions!.find(matches)!;
    return { questionId: question.id };
  }, 'Goal question failed', 'question');
}

export async function listTaktGoalQuestions(input: z.infer<typeof listGoalQuestionsInputSchema>, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const questions = (await new GoalStore(input.cwd).get(input.goalId)).questions ?? [];
    const ordered = [...questions.filter((question) => question.status === 'pending'), ...questions.filter((question) => question.status !== 'pending')];
    const offset = input.offset ?? 0;
    return pagedResult('questions', ordered.slice(offset, offset + (input.limit ?? 50)), ordered.length, offset);
  } catch (error) { return errorResult('Goal question read failed', error); }
}

export async function getTaktGoalQuestion(input: GetGoalQuestionInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const question = (await new GoalStore(input.cwd).get(input.goalId)).questions?.find((saved) => saved.id === input.questionId);
    if (question === undefined) throw new Error('Question does not exist');
    if (input.path !== undefined) return jsonResult({ questionId: question.id, path: input.path, ...goalValuePage(selectGoalValue(question, input.path), input) });
    return jsonResult({ question });
  } catch (error) { return errorResult('Goal question read failed', error); }
}

export function withdrawTaktGoalQuestion(input: z.infer<typeof withdrawGoalQuestionInputSchema>, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const goal = await new GoalStore(input.cwd).update(input.goalId, (current) => withdrawGoalQuestion(current, input.questionId, input.reason));
    return { goalId: goal.id, status: goal.status, questionId: input.questionId,
      questionStatus: goal.questions!.find((question) => question.id === input.questionId)!.status };
  }, 'Goal question withdrawal failed', 'withdraw_question');
}
