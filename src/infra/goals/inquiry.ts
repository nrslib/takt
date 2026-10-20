import { createHash, randomUUID } from 'node:crypto';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GoalInquiryInputSchema, GoalQuestionSchema, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput } from './schema.js';

export function createInquiry(input: GoalQuestionInput): GoalQuestion {
  const id = randomUUID();
  const parsed = GoalInquiryInputSchema.parse(input);
  const operation = parsed.operation === undefined ? undefined : {
    ...parsed.operation,
    argsDigest: createHash('sha256').update(parsed.operation.args).digest('hex'),
    args: sanitizeSensitiveText(parsed.operation.args),
  };
  return GoalQuestionSchema.parse({
    ...parsed, ...(operation === undefined ? {} : { operation }), id, status: 'pending', createdAt: new Date().toISOString(),
  });
}

export function withdrawInquiry(question: GoalQuestion, reason?: string): GoalQuestion {
  if (question.status !== 'pending') return question;
  return GoalQuestionSchema.parse({
    ...question, status: 'withdrawn', ...(reason === undefined ? {} : { withdrawalReason: reason }), withdrawnAt: new Date().toISOString(),
  });
}

export function answerInquiry(question: GoalQuestion, answer: string | GoalAnswerInput): GoalQuestion {
  if (question.status !== 'pending') throw new Error('Question is not awaiting an answer');
  if (question.recipient !== 'human') throw new Error('Question is not addressed to a human');
  return GoalQuestionSchema.parse({
    ...question, status: 'answered', answer: {
      ...(typeof answer === 'string' ? { text: answer } : answer), source: 'tui', answeredAt: new Date().toISOString(),
    },
  });
}

export function isGoalApprovalUsable(question: GoalQuestion): boolean {
  return question.kind === 'approval' && question.status === 'answered'
    && question.answer?.decision === 'allow' && question.consumedAt === undefined;
}

export function consumeInquiryApproval(question: GoalQuestion, consumedAt: string): GoalQuestion {
  if (!isGoalApprovalUsable(question)) throw new Error('Approval is not usable');
  return GoalQuestionSchema.parse({ ...question, consumedAt });
}
