import type { TurnEvent } from '../../core/daemon/events.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import { conversationId } from '../../infra/conversations/identity.js';

export function inquiryAnswerEvent(questionId: string, answer: NonNullable<GoalQuestion['answer']>, questionBody?: string): Extract<TurnEvent, { kind: 'director_message' }> {
  const inquiryAnswer = { questionId, ...(questionBody === undefined ? {} : { question: questionBody }), answer };
  return { kind: 'director_message', directorConversationId: conversationId({ kind: 'daemon' }),
    text: 'A person answered a standalone inquiry.', inquiryAnswer };
}
