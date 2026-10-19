import { createHash, randomUUID } from 'node:crypto';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GoalInquiryInputSchema, GoalQuestionSchema, type Goal, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput } from './schema.js';

export function addGoalQuestion(goal: Goal, input: GoalQuestionInput): { goal: Goal; questionId: string } {
  const id = randomUUID();
  if (goal.questions?.some((question) => question.id === id)) throw new Error('Question ID already exists');
  const parsed = GoalInquiryInputSchema.parse(input);
  const operation = parsed.operation === undefined ? undefined : {
    ...parsed.operation,
    argsDigest: createHash('sha256').update(parsed.operation.args).digest('hex'),
    args: sanitizeSensitiveText(parsed.operation.args),
  };
  const question = GoalQuestionSchema.parse({ ...parsed, ...(operation === undefined ? {} : { operation }), id, status: 'pending', createdAt: new Date().toISOString() });
  return { goal: { ...goal, questions: [...(goal.questions ?? []), question] }, questionId: id };
}

export function withdrawGoalQuestion(goal: Goal, questionId: string, reason?: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (question.status !== 'pending') return goal;
  const withdrawn = GoalQuestionSchema.parse({
    ...question, status: 'withdrawn', ...(reason === undefined ? {} : { withdrawalReason: reason }), withdrawnAt: new Date().toISOString(),
  });
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId ? withdrawn : candidate) };
}

export function answerGoalQuestion(goal: Goal, questionId: string, answer: string | GoalAnswerInput): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (question.status !== 'pending') throw new Error('Question is not awaiting an answer');
  if (question.recipient !== 'human') throw new Error('Question is not addressed to a human');
  const answered = GoalQuestionSchema.parse({
    ...question, status: 'answered', answer: {
      ...(typeof answer === 'string' ? { text: answer } : answer), source: 'tui', answeredAt: new Date().toISOString(),
    },
  });
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

export function isGoalApprovalUsable(question: GoalQuestion): boolean {
  return question.kind === 'approval' && question.status === 'answered'
    && question.answer?.decision === 'allow' && question.consumedAt === undefined;
}

export function consumeGoalApproval(goal: Goal, questionId: string, consumedAt: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (!isGoalApprovalUsable(question)) throw new Error('Approval is not usable');
  const consumed = GoalQuestionSchema.parse({ ...question, consumedAt });
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId ? consumed : candidate) };
}

export function withdrawPendingGoalQuestions(goal: Goal, reason: string, withdrawnAt: string): Goal {
  if (goal.questions === undefined) return goal;
  return { ...goal, questions: goal.questions.map((question) => question.status === 'pending'
    ? GoalQuestionSchema.parse({ ...question, status: 'withdrawn', withdrawalReason: reason, withdrawnAt }) : question) };
}
