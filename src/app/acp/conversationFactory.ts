import { loadTemplate } from '../../shared/prompts/index.js';
import { prependSourceContext } from '../../features/interactive/promptSections.js';
import { initializeSession } from '../../features/interactive/sessionInitialization.js';
import { loadAssistantInitContext } from '../../features/interactive/assistantInitFiles.js';
import {
  DEFAULT_INTERACTIVE_TOOLS,
} from '../../features/interactive/interactiveApplication.js';
import {
  createConversationSession,
  type ConversationSession,
} from '../../features/interactive/conversationSession.js';
import type { AcpConversationSessionOptions } from './types.js';
import { resolveFormalSpecModeWithoutPrompt } from '../../features/interactive/taskInstructionFormat.js';

export function createDefaultConversationSession(options: AcpConversationSessionOptions): ConversationSession {
  const baseCtx = initializeSession(options.cwd, 'interactive');
  const formalSpec = resolveFormalSpecModeWithoutPrompt(options.cwd);
  const systemPrompt = loadTemplate('score_interactive_system_prompt', baseCtx.lang, {
    grillMe: false,
    formalSpec,
    hasWorkflowPreview: false,
    workflowStructure: '',
    stepDetails: '',
    hasRunSession: false,
    runTask: '',
    runWorkflow: '',
    runStatus: '',
    runStepLogs: '',
    runReports: '',
  });
  const assistantInitContext = loadAssistantInitContext(options.cwd);
  return createConversationSession({
    ...options,
    formalSpec,
    ctx: baseCtx,
    strategy: {
      systemPrompt,
      allowedTools: DEFAULT_INTERACTIVE_TOOLS,
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(baseCtx.lang, message, sourceContext),
      summaryPromptContext: assistantInitContext,
      initialPromptContext: assistantInitContext,
    },
  });
}
