import {
  createConversationSession,
  type ConversationSession,
} from '../../features/interactive/conversationSession.js';
import { createAssistantConversationPlan } from '../../features/interactive/conversationPlan.js';
import type { AcpConversationSessionOptions } from './types.js';

export function createDefaultConversationSession(options: AcpConversationSessionOptions): ConversationSession {
  const { ctx, strategy } = createAssistantConversationPlan(options.cwd, { assistantMode: 'assistant' });
  return createConversationSession({ ...options, ctx, strategy });
}
