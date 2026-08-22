/**
 * Conversation plans shared by every interactive front-end.
 *
 * The readline loop, the ACP adapter and the Ink TUI all need the same
 * per-mode system prompt, tool set, permission mode and prompt transform.
 * They are built here once so a front-end never re-derives them; only the
 * front-end-specific parts (how the user is prompted, how output is rendered)
 * stay in the front-end.
 */

import type { AssistantInteractiveMode } from '../../core/models/index.js';
import type { FirstStepInfo } from '../../infra/config/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import type { SessionContext } from './aiCaller.js';
import { getAssistantSessionPersona } from './assistantMode.js';
import { loadAssistantInitContext } from './assistantInitFiles.js';
import type { ConversationStrategy } from './conversationLoop.js';
import { DEFAULT_INTERACTIVE_TOOLS } from './interactiveApplication.js';
import { formatStepPreviews } from './interactive-summary.js';
import type { WorkflowContext } from './interactive-summary-types.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from './promptSections.js';
import { formatRunSessionForPrompt, type RunSessionContext } from './runSessionReader.js';
import { initializeSession } from './sessionInitialization.js';

/**
 * The order `/replay` resubmits and `/retry` offers, or nothing when there is
 * none. An order file that exists but is empty is nothing to resend, and both
 * front-ends have to read it the same way — the readline loop and the TUI used
 * to disagree about the empty string.
 */
export function resolvePreviousOrder(previousOrderContent: string | undefined): string | undefined {
  return previousOrderContent === undefined || previousOrderContent === ''
    ? undefined
    : previousOrderContent;
}

/** Grill Me withholds Bash so the assistant interrogates instead of acting. */
const GRILL_ME_INTERACTIVE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

const EMPTY_RUN_SESSION_VARS = {
  runTask: '',
  runWorkflow: '',
  runStatus: '',
  runStepLogs: '',
  runReports: '',
};

export interface InteractiveSystemPromptInput {
  grillMe: boolean;
  workflowContext?: WorkflowContext;
  runSessionContext?: RunSessionContext;
}

export function buildInteractiveSystemPrompt(
  lang: 'en' | 'ja',
  input: InteractiveSystemPromptInput,
): string {
  const stepPreviews = input.workflowContext?.stepPreviews;
  const hasWorkflowPreview = stepPreviews !== undefined && stepPreviews.length > 0;
  const runSessionVars = input.runSessionContext
    ? formatRunSessionForPrompt(input.runSessionContext)
    : EMPTY_RUN_SESSION_VARS;

  return loadTemplate('score_interactive_system_prompt', lang, {
    grillMe: input.grillMe,
    hasWorkflowPreview,
    workflowStructure: input.workflowContext?.workflowStructure ?? '',
    stepDetails: hasWorkflowPreview ? formatStepPreviews(stepPreviews, lang) : '',
    hasRunSession: input.runSessionContext !== undefined,
    ...runSessionVars,
  });
}

/** A resolved session plus the strategy every front-end drives it with. */
export interface ConversationPlan {
  ctx: SessionContext;
  strategy: ConversationStrategy;
}

export interface AssistantConversationInput {
  assistantMode: AssistantInteractiveMode;
  workflowContext?: WorkflowContext;
  runSessionContext?: RunSessionContext;
  provider?: ProviderType;
  model?: string;
  sessionId?: string;
}

export function createAssistantConversationPlan(
  cwd: string,
  input: AssistantConversationInput,
): ConversationPlan {
  // Omitted entirely when the CLI gave no override, so the assistant provider
  // ladder resolves exactly as it does without the flags.
  const persona = getAssistantSessionPersona(input.assistantMode);
  // The third argument is omitted, not passed as undefined, so the assistant
  // provider ladder sees exactly the call shape it saw before the CLI flags.
  const sessionArgs: Parameters<typeof initializeSession> = input.provider || input.model
    ? [cwd, persona, {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    }]
    : [cwd, persona];
  const baseCtx = initializeSession(...sessionArgs);
  const ctx = input.sessionId ? { ...baseCtx, sessionId: input.sessionId } : baseCtx;
  const grillMe = input.assistantMode === 'grill-me';
  const assistantInitContext = loadAssistantInitContext(cwd);

  return {
    ctx,
    strategy: {
      systemPrompt: buildInteractiveSystemPrompt(ctx.lang, {
        grillMe,
        ...(input.workflowContext ? { workflowContext: input.workflowContext } : {}),
        ...(input.runSessionContext ? { runSessionContext: input.runSessionContext } : {}),
      }),
      allowedTools: grillMe ? GRILL_ME_INTERACTIVE_TOOLS : DEFAULT_INTERACTIVE_TOOLS,
      ...(grillMe ? { permissionMode: 'readonly' as const } : {}),
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(ctx.lang, message, sourceContext),
      introMessage: getLabel(grillMe ? 'interactive.ui.introGrillMe' : 'interactive.ui.intro', ctx.lang),
      initialPromptContext: assistantInitContext,
      summaryPromptContext: assistantInitContext,
    },
  };
}

export function createPersonaConversationPlan(
  cwd: string,
  firstStep: FirstStepInfo,
): ConversationPlan {
  const ctx = initializeSession(cwd, 'persona-interactive');

  return {
    ctx,
    strategy: {
      systemPrompt: prependSourceContextGuardToSystemPrompt(ctx.lang, firstStep.personaContent),
      allowedTools: firstStep.allowedTools.length > 0
        ? firstStep.allowedTools
        : DEFAULT_INTERACTIVE_TOOLS,
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(ctx.lang, message, sourceContext),
      introMessage: `${getLabel('interactive.ui.intro', ctx.lang)} [${firstStep.personaDisplayName}]`,
    },
  };
}
