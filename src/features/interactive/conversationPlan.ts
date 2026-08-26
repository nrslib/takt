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
import type {
  ConversationPromptConfiguration,
  ConversationStrategy,
} from './conversationLoop.js';
import { DEFAULT_INTERACTIVE_TOOLS } from './interactiveApplication.js';
import { formatStepPreviews } from './interactive-summary.js';
import type { WorkflowContext } from './interactive-summary-types.js';
import {
  frameUserComment,
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from './promptSections.js';
import { formatRunSessionForPrompt, type RunSessionContext } from './runSessionReader.js';
import { initializeSession } from './sessionInitialization.js';
import {
  resolveFormalSpecMode,
  resolveFormalSpecModeWithoutPrompt,
} from './taskInstructionFormat.js';

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

const INTERACTIVE_INVESTIGATION_POLICIES = {
  assistant: {
    currentStateScope: 'current-state-and-prerequisites',
    implementationInvestigationOwner: 'workflow-execution',
  },
  grillMe: {
    currentStateScope: 'requirements-decisions-only',
    implementationInvestigationOwner: 'workflow-execution',
  },
} as const;

function serializeInvestigationPolicy(
  policy: (typeof INTERACTIVE_INVESTIGATION_POLICIES)[keyof typeof INTERACTIVE_INVESTIGATION_POLICIES],
): string {
  const serialized = JSON.stringify(policy);
  if (serialized === undefined) {
    throw new Error('Interactive investigation policy must be serializable');
  }
  return serialized;
}

export interface InteractiveSystemPromptInput {
  grillMe: boolean;
  formalSpec?: boolean;
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
  const investigationPolicy = input.grillMe
    ? INTERACTIVE_INVESTIGATION_POLICIES.grillMe
    : INTERACTIVE_INVESTIGATION_POLICIES.assistant;

  return loadTemplate('score_interactive_system_prompt', lang, {
    grillMe: input.grillMe,
    investigationPolicy: serializeInvestigationPolicy(investigationPolicy),
    formalSpec: input.formalSpec ?? false,
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
  /** Initial value resolved by the front-end before the conversation starts. */
  formalSpec?: boolean;
  workflowContext?: WorkflowContext;
  runSessionContext?: RunSessionContext;
  provider?: ProviderType;
  model?: string;
  effort?: string;
  /** Temporary model/effort errors must remain visible until the user retries. */
  disableSessionRetry?: boolean;
  sessionId?: string;
  /** Already resolved provider state retained across a TUI-only session rebuild. */
  resolvedSessionContext?: SessionContext;
}

interface ConversationSessionResolution {
  provider?: ProviderType;
  model?: string;
  resolvedSessionContext?: SessionContext;
}

interface ConversationSessionOverrides extends ConversationSessionResolution {
  effort?: string;
  disableSessionRetry?: boolean;
}

function resolveConversationSessionContext(
  cwd: string,
  personaName: string,
  overrides: ConversationSessionResolution,
): SessionContext {
  if (overrides.resolvedSessionContext !== undefined) {
    return {
      ...overrides.resolvedSessionContext,
      personaName,
      sessionId: undefined,
      ...(overrides.model ? { model: overrides.model } : {}),
    };
  }
  if (!overrides.provider && !overrides.model) {
    return initializeSession(cwd, personaName);
  }
  return initializeSession(cwd, personaName, {
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  });
}

export function createAssistantConversationPlan(
  cwd: string,
  input: AssistantConversationInput,
): ConversationPlan {
  const persona = getAssistantSessionPersona(input.assistantMode);
  const baseCtx = resolveConversationSessionContext(cwd, persona, input);
  const ctx: SessionContext = {
    ...baseCtx,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.disableSessionRetry ? { disableSessionRetry: true } : {}),
  };
  const grillMe = input.assistantMode === 'grill-me';
  const assistantInitContext = loadAssistantInitContext(cwd);
  const formalSpec = input.formalSpec ?? resolveFormalSpecModeWithoutPrompt(cwd);
  const buildPromptConfiguration = (resolvedFormalSpec: boolean): ConversationPromptConfiguration => ({
    formalSpec: resolvedFormalSpec,
    systemPrompt: buildInteractiveSystemPrompt(ctx.lang, {
      grillMe,
      formalSpec: resolvedFormalSpec,
      ...(input.workflowContext ? { workflowContext: input.workflowContext } : {}),
      ...(input.runSessionContext ? { runSessionContext: input.runSessionContext } : {}),
    }),
  });
  const resolvePromptConfiguration = async (): Promise<ConversationPromptConfiguration> =>
    buildPromptConfiguration(await resolveFormalSpecMode(cwd));
  const initialPromptConfiguration = buildPromptConfiguration(formalSpec);

  return {
    ctx,
    strategy: {
      ...initialPromptConfiguration,
      allowedTools: grillMe ? GRILL_ME_INTERACTIVE_TOOLS : DEFAULT_INTERACTIVE_TOOLS,
      ...(grillMe ? { permissionMode: 'readonly' as const } : {}),
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(ctx.lang, frameUserComment(ctx.lang, message), sourceContext),
      introMessage: getLabel(grillMe ? 'interactive.ui.introGrillMe' : 'interactive.ui.intro', ctx.lang),
      initialPromptContext: assistantInitContext,
      summaryPromptContext: assistantInitContext,
      resolveResumedSessionConfiguration: resolvePromptConfiguration,
    },
  };
}

export function createPersonaConversationPlan(
  cwd: string,
  firstStep: FirstStepInfo,
  overrides: ConversationSessionOverrides = {},
): ConversationPlan {
  const baseCtx = resolveConversationSessionContext(cwd, 'persona-interactive', overrides);
  const ctx: SessionContext = {
    ...baseCtx,
    ...(overrides.effort ? { effort: overrides.effort } : {}),
    ...(overrides.disableSessionRetry ? { disableSessionRetry: true } : {}),
  };

  return {
    ctx,
    strategy: {
      systemPrompt: prependSourceContextGuardToSystemPrompt(ctx.lang, firstStep.personaContent),
      formalSpec: false,
      allowedTools: firstStep.allowedTools.length > 0
        ? firstStep.allowedTools
        : DEFAULT_INTERACTIVE_TOOLS,
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(ctx.lang, message, sourceContext),
      introMessage: `${getLabel('interactive.ui.intro', ctx.lang)} [${firstStep.personaDisplayName}]`,
    },
  };
}
