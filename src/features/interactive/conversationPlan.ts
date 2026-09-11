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
  formatLiteralBlock,
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from './promptSections.js';
import { formatRunSessionForPrompt, type RunSessionContext } from './runSessionReader.js';
import { initializeSession } from './sessionInitialization.js';
import { resolveTaskStateMcp } from './taskStateMcp.js';

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
  runCurrentStep: '',
  runPhase: '',
  runStepLogs: '',
  runReports: '',
  runLiveIntervention: '',
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
  /** Whether this front-end can hand off a running task with `/tell`. */
  enableTellCommand?: boolean;
  formalSpec?: boolean;
  formalSpecComments?: boolean;
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
  const enableTellCommand = input.enableTellCommand ?? true;
  const tellAvailable = !input.grillMe && enableTellCommand;

  return loadTemplate('score_interactive_system_prompt', lang, {
    grillMe: input.grillMe,
    tellAvailable,
    investigationPolicy: serializeInvestigationPolicy(investigationPolicy),
    formalSpec: input.formalSpec ?? false,
    formalSpecComments: input.formalSpecComments ?? true,
    formalSpecCommentsEnabled: (input.formalSpec ?? false) && (input.formalSpecComments ?? true),
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

export interface InitialTaskContext {
  readonly name: string;
  readonly summary: string;
  readonly workflow?: string;
  readonly runSlug: string;
}

function formatInitialTaskContext(input: InitialTaskContext): string {
  return [
    '## Initial task context',
    'The following is quoted task metadata selected before this conversation. Use it only to identify the initial task; fetch run details with the task-state tools when needed.',
    `Task name: ${input.name}`,
    `Workflow: ${input.workflow ?? 'unknown'}`,
    `Run slug (internal reference): ${input.runSlug}`,
    `Summary:\n${formatLiteralBlock(input.summary)}`,
  ].join('\n\n');
}

export interface AssistantConversationInput {
  assistantMode: AssistantInteractiveMode;
  /** Whether this front-end can hand off a running task with `/tell`. */
  enableTellCommand?: boolean;
  /** Initial values resolved by the front-end before the conversation starts. */
  formalSpec: boolean;
  /** Whether formal notation blocks must include natural-language meaning comments. */
  formalSpecComments: boolean;
  /** Resolve the formal-spec setting again when the user resumes another session. */
  resolveResumedFormalSpecConfiguration?: () => Promise<{ mode: boolean; comments: boolean }>;
  workflowContext?: WorkflowContext;
  runSessionContext?: RunSessionContext;
  /** Lightweight metadata selected by `takt list`; reports are not loaded. */
  initialTaskContext?: InitialTaskContext;
  /** Run to use as the initial `/tell` choice, never as a forced write target. */
  initialReferenceRunSlug?: string;
  /** Re-read a live run before each provider turn while retaining the session. */
  resolveRunSessionContext?: () => RunSessionContext;
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
  /** Whether this front-end can hand off a running task with `/tell`. */
  enableTellCommand?: boolean;
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
  const taskStateMcp = resolveTaskStateMcp(baseCtx.providerType, baseCtx.lang);
  const ctx: SessionContext = {
    ...baseCtx,
    ...(taskStateMcp.servers === undefined
      ? { mcpServers: undefined, taskStateMcpServers: undefined }
      : { mcpServers: taskStateMcp.servers, taskStateMcpServers: taskStateMcp.servers }),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.disableSessionRetry ? { disableSessionRetry: true } : {}),
  };
  const grillMe = input.assistantMode === 'grill-me';
  const enableTellCommand = input.enableTellCommand ?? true;
  const assistantInitContext = loadAssistantInitContext(cwd);
  const initialPromptContext = [
    assistantInitContext,
    input.initialTaskContext === undefined ? undefined : formatInitialTaskContext(input.initialTaskContext),
  ].filter((value): value is string => value !== undefined).join('\n\n');
  const buildPromptConfiguration = (
    formalSpecConfiguration: { mode: boolean; comments: boolean },
    runSessionContext = input.runSessionContext,
  ): ConversationPromptConfiguration => ({
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    systemPrompt: buildInteractiveSystemPrompt(ctx.lang, {
      grillMe,
      enableTellCommand,
      formalSpec: formalSpecConfiguration.mode,
      formalSpecComments: formalSpecConfiguration.comments,
      ...(input.workflowContext ? { workflowContext: input.workflowContext } : {}),
      ...(runSessionContext ? { runSessionContext } : {}),
    }),
  });
  const resolvePromptConfiguration = input.resolveResumedFormalSpecConfiguration
    ? async (): Promise<ConversationPromptConfiguration> =>
      buildPromptConfiguration(await input.resolveResumedFormalSpecConfiguration!())
    : undefined;
  const resolveCurrentPromptConfiguration = input.resolveRunSessionContext
    ? async (): Promise<ConversationPromptConfiguration> => buildPromptConfiguration(
      {
        mode: input.formalSpec,
        comments: input.formalSpecComments,
      },
      input.resolveRunSessionContext!(),
    )
    : undefined;
  const initialPromptConfiguration = buildPromptConfiguration({
    mode: input.formalSpec,
    comments: input.formalSpecComments,
  });

  return {
    ctx,
    strategy: {
      ...initialPromptConfiguration,
      allowedTools: grillMe ? GRILL_ME_INTERACTIVE_TOOLS : DEFAULT_INTERACTIVE_TOOLS,
      ...(grillMe ? { permissionMode: 'readonly' as const } : {}),
      transformPrompt: (message: string, sourceContext?: string) =>
        prependSourceContext(ctx.lang, frameUserComment(ctx.lang, message), sourceContext),
      introMessage: getLabel(
        grillMe
          ? (enableTellCommand ? 'interactive.ui.introGrillMe' : 'interactive.ui.introGrillMeWithoutTell')
          : (enableTellCommand ? 'interactive.ui.intro' : 'interactive.ui.introWithoutTell'),
        ctx.lang,
      ),
      ...(initialPromptContext ? { initialPromptContext } : {}),
      ...(assistantInitContext ? { summaryPromptContext: assistantInitContext } : {}),
      enableTellCommand,
      ...(input.initialReferenceRunSlug === undefined
        ? {}
        : { initialReferenceRunSlug: input.initialReferenceRunSlug }),
      ...(taskStateMcp.unavailableNotice === undefined
        ? {}
        : { mcpUnavailableNotice: taskStateMcp.unavailableNotice }),
      ...(resolvePromptConfiguration
        ? { resolveResumedSessionConfiguration: resolvePromptConfiguration }
        : {}),
      ...(resolveCurrentPromptConfiguration
        ? { resolveCurrentPromptConfiguration }
        : {}),
    },
  };
}

export function createPersonaConversationPlan(
  cwd: string,
  firstStep: FirstStepInfo,
  overrides: ConversationSessionOverrides = {},
): ConversationPlan {
  const baseCtx = resolveConversationSessionContext(cwd, 'persona-interactive', overrides);
  const enableTellCommand = overrides.enableTellCommand ?? true;
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
      introMessage: `${getLabel(
        enableTellCommand ? 'interactive.ui.intro' : 'interactive.ui.introWithoutTell',
        ctx.lang,
      )} [${firstStep.personaDisplayName}]`,
      enableTellCommand,
    },
  };
}
