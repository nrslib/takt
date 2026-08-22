import {
  createConversationSession,
  type ConversationSession,
} from '../../features/interactive/conversationSession.js';
import { createAssistantConversationPlan } from '../../features/interactive/conversationPlan.js';
import type { AcpConversationSessionOptions } from './types.js';
import { resolveFormalSpecModeWithoutPrompt } from '../../features/interactive/taskInstructionFormat.js';

export function createDefaultConversationSession(options: AcpConversationSessionOptions): ConversationSession {
  const formalSpec = resolveFormalSpecModeWithoutPrompt(options.cwd);
  const { ctx, strategy } = createAssistantConversationPlan(options.cwd, {
    assistantMode: 'assistant',
    formalSpec,
  });
  return createConversationSession({ ...options, formalSpec, ctx, strategy });
}
