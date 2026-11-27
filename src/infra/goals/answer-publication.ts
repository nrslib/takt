import { GoalStore } from './store.js';
import { answerGoalQuestion } from './questions.js';
import { saveManagerEvent } from './events.js';
import type { Goal, GoalAnswerInput, GoalQuestion, GoalQuestionRoute } from './schema.js';

type GoalAnswer = NonNullable<GoalQuestion['answer']>;

function withAnswerPublicationPending(goal: Goal, questionId: string, pending: boolean): Goal {
  return {
    ...goal,
    questions: goal.questions?.map((candidate) => candidate.id === questionId
      ? { ...candidate, answerPublicationPending: pending ? true : undefined }
      : candidate),
  };
}

/** 回答を受信箱へ書けなかった場合も印が残り、daemon が知らせ直す（pendingInquiryAnswers.ts の publishPendingGoalAnswers）。 */
export async function answerGoalQuestionForPublication(cwd: string, goalId: string, questionId: string,
  answer: string | GoalAnswerInput, source: GoalAnswer['source'], onSaved: () => void, answeredBy: GoalQuestionRoute): Promise<GoalAnswer> {
  const saved = await new GoalStore(cwd).update(goalId,
    (goal) => withAnswerPublicationPending(answerGoalQuestion(goal, questionId, answer, source, answeredBy), questionId, true), onSaved);
  const savedAnswer = saved.questions!.find((question) => question.id === questionId)!.answer!;
  await publishGoalAnswer(cwd, goalId, questionId, savedAnswer);
  return savedAnswer;
}

async function publishGoalAnswer(cwd: string, goalId: string, questionId: string, answer: GoalAnswer): Promise<void> {
  saveManagerEvent(cwd, { kind: 'answer', goalId, questionId, answer });
  await new GoalStore(cwd).update(goalId, (goal) =>
    goal.questions?.find((question) => question.id === questionId)?.answerPublicationPending === true
      ? withAnswerPublicationPending(goal, questionId, false)
      : goal);
}
