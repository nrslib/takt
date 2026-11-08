import type { GoalQuestion } from '../../infra/goals/schema.js';

export function inquiryAnswerMessage(questionId: string, answer: NonNullable<GoalQuestion['answer']>, questionBody?: string): string {
  return `A person answered a standalone inquiry. ${JSON.stringify({ questionId,
    ...(questionBody === undefined ? {} : { question: questionBody }), answer })}`;
}
