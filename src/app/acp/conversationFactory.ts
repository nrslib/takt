import {
  createConversationSession,
  type ConversationSession,
} from '../../features/interactive/conversationSession.js';
import { createAssistantConversationPlan } from '../../features/interactive/conversationPlan.js';
import type { AcpConversationSessionOptions } from './types.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../../features/interactive/taskInstructionFormat.js';

export function createDefaultConversationSession({
  onMcpUnavailableNotice,
  ...sessionOptions
}: AcpConversationSessionOptions): ConversationSession {
  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(sessionOptions.cwd);
  const { ctx, strategy } = createAssistantConversationPlan(sessionOptions.cwd, {
    assistantMode: 'assistant',
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    modelCheckTimeoutSeconds: formalSpecConfiguration.modelCheckTimeoutSeconds,
    enableAssistantRetryCommands: false,
  });
  if (strategy.mcpUnavailableNotice !== undefined) {
    onMcpUnavailableNotice?.(strategy.mcpUnavailableNotice);
  }
  return createConversationSession({
    ...sessionOptions,
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    modelCheckTimeoutSeconds: formalSpecConfiguration.modelCheckTimeoutSeconds,
    ctx,
    strategy,
  });
}
