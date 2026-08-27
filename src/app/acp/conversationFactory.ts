import {
  createConversationSession,
  type ConversationSession,
} from '../../features/interactive/conversationSession.js';
import { createAssistantConversationPlan } from '../../features/interactive/conversationPlan.js';
import type { AcpConversationSessionOptions } from './types.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../../features/interactive/taskInstructionFormat.js';

export function createDefaultConversationSession(options: AcpConversationSessionOptions): ConversationSession {
  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(options.cwd);
  const { ctx, strategy } = createAssistantConversationPlan(options.cwd, {
    assistantMode: 'assistant',
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
  });
  return createConversationSession({
    ...options,
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    ctx,
    strategy,
  });
}
