import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { withInquiryLock } from '../../infra/goals/inquiry-lock.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { GoalStore } from '../../infra/goals/store.js';
import { addGoalQuestion, answerGoalQuestion, withdrawGoalQuestion } from '../../infra/goals/questions.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../../infra/goals/notifications.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import { answerGoalQuestionInputSchema, type AnswerGoalQuestionInput } from './schemas.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import type { AskGoalQuestionInput, GetGoalQuestionInput, listGoalQuestionsInputSchema, withdrawGoalQuestionInputSchema } from './schemas.js';
import type { z } from 'zod/v4';
import { goalValuePage, selectGoalValue } from './goalResponse.js';
import { pagedResult } from './response.js';
import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';

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

function withAnswerPublicationPending(goal: Goal, questionId: string, pending: boolean): Goal {
  return {
    ...goal,
    questions: goal.questions?.map((candidate) => candidate.id === questionId
      ? { ...candidate, answerPublicationPending: pending ? true : undefined }
      : candidate),
  };
}

function publishAnswer(cwd: string, goalId: string, questionId: string, answer: NonNullable<GoalQuestion['answer']>): void {
  try {
    saveManagerEvent(cwd, { kind: 'answer', goalId, questionId, answer });
  } catch (eventError) {
    throw new Error(`The answer was saved, but the manager event could not be recorded: ${eventError instanceof Error ? eventError.message : String(eventError)}. Publication is pending; retry the same call to publish it.`);
  }
}

export async function answerTaktGoalQuestion(input: AnswerGoalQuestionInput, deps: McpOperationDependencies, signal: AbortSignal) {
  try {
    const parsed = answerGoalQuestionInputSchema.parse(input);
    assertCwdAllowedByMcpRoot(parsed.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(parsed.cwd);
    const question = (await store.get(parsed.goalId)).questions?.find((saved) => saved.id === parsed.questionId);
    if (question === undefined) throw new Error('Question does not exist');
    if ((question.kind ?? 'question') === 'approval') {
      throw new Error('Approval inquiries are retired and cannot be answered; answer a question or operation_request instead');
    }
    signal.throwIfAborted();
    if (question.status === 'answered' && question.answerPublicationPending === true) {
      const stored = question.answer!;
      if (parsed.answer.text !== stored.text || parsed.answer.report !== stored.report) {
        throw new Error('Question is already answered with a different answer');
      }
      publishAnswer(parsed.cwd, parsed.goalId, parsed.questionId, stored);
      await store.update(parsed.goalId, (goal) => withAnswerPublicationPending(goal, parsed.questionId, false));
      return jsonResult({ questionId: parsed.questionId, answer: stored });
    }
    const saved = await store.update(parsed.goalId,
      (goal) => withAnswerPublicationPending(answerGoalQuestion(goal, parsed.questionId, parsed.answer, 'mcp'), parsed.questionId, true));
    const answer = saved.questions!.find((savedQuestion) => savedQuestion.id === parsed.questionId)!.answer!;
    publishAnswer(parsed.cwd, parsed.goalId, parsed.questionId, answer);
    await store.update(parsed.goalId, (goal) => withAnswerPublicationPending(goal, parsed.questionId, false));
    return jsonResult({ questionId: parsed.questionId, answer });
  } catch (error) { return errorResult('Goal question answer failed', error); }
}
