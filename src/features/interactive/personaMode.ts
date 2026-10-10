/**
 * Persona interactive mode.
 *
 * Uses the first step's persona and tools for the interactive
 * conversation. The persona acts as the conversational agent,
 * performing code exploration and analysis while discussing the task.
 * The conversation result is passed as the task to the workflow.
 */

import type { FirstStepInfo } from '../../infra/config/index.js';
import {
  type WorkflowContext,
  type InteractiveModeResult,
  type InteractiveSeedInput,
  type InteractiveUIText,
  type SummaryActionValue,
  createPostSummaryActionSelector,
} from './interactive.js';
import { getLabelObject } from '../../shared/i18n/index.js';
import {
  runConversationLoop,
} from './conversationLoop.js';
import { createPersonaConversationPlan } from './conversationPlan.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from './taskInstructionFormat.js';
import type { ConversationDispatchOutcome } from './actionDispatcher.js';

export interface PersonaModeOptions {
  excludeActions?: readonly SummaryActionValue[];
  dispatch?: (result: InteractiveModeResult) => Promise<ConversationDispatchOutcome>;
}

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
  options?: PersonaModeOptions,
): Promise<InteractiveModeResult> {
  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  const { ctx, strategy } = createPersonaConversationPlan(cwd, firstStep, {
    modelCheckTimeoutSeconds: formalSpecConfiguration.modelCheckTimeoutSeconds,
  });

  const excludeActions = options?.excludeActions;
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);
  const selectAction = excludeActions?.length
    ? createPostSummaryActionSelector(ui.proposed, ui, excludeActions)
    : undefined;

  return runConversationLoop(cwd, ctx, {
    ...strategy,
    selectAction,
    ...(options?.dispatch === undefined ? {} : { dispatch: options.dispatch }),
  }, workflowContext, initialInput);
}
