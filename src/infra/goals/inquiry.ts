import { createHash, randomUUID } from 'node:crypto';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { GoalAnswerInputSchema, GoalInquiryInputSchema, GoalQuestionSchema, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput, type GoalQuestionRoute } from './schema.js';

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

export function answerInquiry(question: GoalQuestion, answer: string | GoalAnswerInput,
  source: NonNullable<GoalQuestion['answer']>['source'], answeredBy: GoalQuestionRoute): GoalQuestion {
  if (question.status !== 'pending') throw new Error('Question is not awaiting an answer');
  if (question.recipient !== answeredBy) throw new Error('Question is not addressed to this respondent');
  const parsed = GoalAnswerInputSchema.parse(typeof answer === 'string' ? { text: answer } : answer);
  return GoalQuestionSchema.parse({
    ...question, status: 'answered', answer: {
      ...parsed, source, answeredBy, answeredAt: new Date().toISOString(),
    },
  });
}
