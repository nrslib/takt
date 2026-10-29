import { GoalQuestionSchema, type Goal, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput } from './schema.js';
import { createInquiry, withdrawInquiry, answerInquiry, consumeInquiryApproval } from './inquiry.js';

export { isGoalApprovalUsable } from './inquiry.js';

export function addGoalQuestion(goal: Goal, input: GoalQuestionInput): { goal: Goal; questionId: string } {
  const question = createInquiry(input);
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
  source: NonNullable<GoalQuestion['answer']>['source'] = 'tui'): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  const answered = answerInquiry(question, answer, source);
  return {
    ...goal,
    questions: goal.questions?.map((candidate) => candidate.id === questionId ? answered : candidate),
  };
}

export function isSameGoalOperation(left: GoalQuestion, right: GoalQuestion): boolean {
  return left.operation !== undefined && right.operation !== undefined
    && left.operation.toolName === right.operation.toolName
    && left.operation.argsDigest === right.operation.argsDigest
    && left.operation.cwd === right.operation.cwd
    && left.targetSha === right.targetSha;
}

export function consumeGoalApproval(goal: Goal, questionId: string, consumedAt: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  const consumed = consumeInquiryApproval(question, consumedAt);
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId ? consumed : candidate) };
}

export function withdrawPendingGoalQuestions(goal: Goal, reason: string, withdrawnAt: string): Goal {
  if (goal.questions === undefined) return goal;
  return { ...goal, questions: goal.questions.map((question) => question.status === 'pending'
    ? GoalQuestionSchema.parse({ ...question, status: 'withdrawn', withdrawalReason: reason, withdrawnAt }) : question) };
}
