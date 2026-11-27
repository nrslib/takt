import { GoalQuestionSchema, GoalInquiryInputSchema, type Goal, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput, type GoalQuestionRoute } from './schema.js';
import { createInquiry, withdrawInquiry, answerInquiry } from './inquiry.js';
import { questionRecipient } from './question-routing.js';

export function addGoalQuestion(goal: Goal, input: GoalQuestionInput): { goal: Goal; questionId: string } {
  if (goal.status === 'completed' || goal.executionStatus === 'aborted') throw new Error('Goal is finished. New questions cannot be added.');
  const parsed = GoalInquiryInputSchema.parse(input);
  const question = createInquiry({ ...parsed, recipient: questionRecipient(parsed.questionType, goal.questionRoute) });
  if (goal.questions?.some((candidate) => candidate.id === question.id)) throw new Error('Question ID already exists');
  return { goal: { ...goal, questions: [...(goal.questions ?? []), question] }, questionId: question.id };
}

export function withdrawGoalQuestion(goal: Goal, questionId: string, reason?: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (question.status !== 'pending') return goal;
  const withdrawn = withdrawInquiry(question, reason);
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId ? withdrawn : candidate) };
}

export function answerGoalQuestion(goal: Goal, questionId: string, answer: string | GoalAnswerInput,
  source: NonNullable<GoalQuestion['answer']>['source'], answeredBy: GoalQuestionRoute): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (goal.status === 'completed' || goal.executionStatus === 'aborted') throw new Error('Goal is finished');
  const answered = answerInquiry(question, answer, source, answeredBy);
  return {
    ...goal,
    questions: goal.questions?.map((candidate) => candidate.id === questionId ? answered : candidate),
  };
}

export function setGoalQuestionRoute(goal: Goal, questionRoute: GoalQuestionRoute): Goal {
  if (goal.status === 'completed' || goal.executionStatus === 'aborted') throw new Error('Goal is finished');
  return { ...goal, questionRoute, questions: goal.questions?.map((question) => question.status === 'pending'
    ? { ...question, recipient: questionRecipient(GoalQuestionSchema.parse(question).questionType, questionRoute) } : question) };
}

export function escalateGoalQuestion(goal: Goal, questionId: string): Goal {
  const question = goal.questions?.find(({ id }) => id === questionId);
  if (goal.status === 'completed' || goal.executionStatus === 'aborted' || question?.status !== 'pending'
    || question.recipient !== 'director') throw new Error('Pending director question required');
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId
    ? { ...candidate, questionType: 'unsure', recipient: 'human' } : candidate) };
}

export function withdrawPendingGoalQuestions(goal: Goal, reason: string, withdrawnAt: string): Goal {
  if (goal.questions === undefined) return goal;
  return { ...goal, questions: goal.questions.map((question) => question.status === 'pending'
    ? GoalQuestionSchema.parse({ ...question, status: 'withdrawn', withdrawalReason: reason, withdrawnAt }) : question) };
}
