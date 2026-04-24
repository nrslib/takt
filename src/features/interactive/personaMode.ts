/**
 * Persona interactive mode.
 *
 * Uses the first step's persona and tools for the interactive
 * conversation. The persona acts as the conversational agent,
 * performing code exploration and analysis while discussing the task.
 * The conversation result is passed as the task to the workflow.
 */

import type { FirstStepInfo } from '../../infra/config/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import {
  type WorkflowContext,
  type InteractiveModeResult,
  type InteractiveSeedInput,
  DEFAULT_INTERACTIVE_TOOLS,
} from './interactive.js';
import {
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from './promptSections.js';
import { initializeSession } from './sessionInitialization.js';

/**
 * Run persona mode: converse as the first step's persona.
 *
 * The persona's system prompt is used for all AI calls.
 * The first step's allowed tools are made available.
 * After the conversation, the result is summarized as a task.
 *
 * @param cwd - Working directory
 * @param firstStep - First step's persona and tool info
 * @param initialInput - Pre-filled input
 * @param workflowContext - Workflow context for summary generation
 * @returns Result with conversation-derived task
 */
export async function personaMode(
  cwd: string,
  firstStep: FirstStepInfo,
  initialInput?: InteractiveSeedInput,
  workflowContext?: WorkflowContext,
): Promise<InteractiveModeResult> {
  const ctx = initializeSession(cwd, 'persona-interactive');

  displayAndClearSessionState(cwd, ctx.lang);

  const allowedTools = firstStep.allowedTools.length > 0
    ? firstStep.allowedTools
    : DEFAULT_INTERACTIVE_TOOLS;

  const introMessage = `${getLabel('interactive.ui.intro', ctx.lang)} [${firstStep.personaDisplayName}]`;

  return runConversationLoop(cwd, ctx, {
    systemPrompt: prependSourceContextGuardToSystemPrompt(ctx.lang, firstStep.personaContent),
    allowedTools,
    transformPrompt: (msg, sourceContext) => prependSourceContext(ctx.lang, msg, sourceContext),
    introMessage,
  }, workflowContext, initialInput);
}
