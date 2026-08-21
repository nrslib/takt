/**
 * Interactive task input mode
 *
 * Allows users to refine task requirements through conversation with AI
 * before executing the task. Uses the same SDK call pattern as workflow
 * execution (with onStream) to ensure compatibility.
 *
 * Commands:
 *   /go     - Confirm and execute the task
 *   /cancel - Cancel and exit
 */

import type { AssistantInteractiveMode, Language } from '../../core/models/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import {
  type SessionState,
} from '../../infra/config/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import {
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';
import { createAssistantConversationPlan } from './conversationPlan.js';
import {
  type WorkflowContext,
  type ConversationMessage,
  buildSummaryPrompt as buildInteractiveSummaryPrompt,
  type InteractiveModeAction,
  type SummaryActionValue,
  createPostSummaryActionSelector,
} from './interactive-summary.js';
import { buildConversationSummaryPrompt } from './interactiveApplication.js';
import { type RunSessionContext } from './runSessionReader.js';
import type { ImageAttachmentCleanupOwner, InteractiveImageAttachment } from './imageAttachments.js';

/** Shape of interactive UI text */
export interface InteractiveUIText {
  intro: string;
  introGrillMe: string;
  resume: string;
  noConversation: string;
  summarizeFailed: string;
  continuePrompt: string;
  proposed: string;
  actionPrompt: string;
  actions: {
    execute: string;
    createIssue: string;
    saveTask: string;
    continue: string;
  };
  cancelled: string;
  acceptNoAssistant: string;
  playNoTask: string;
  retryNoOrder: string;
  retryUnavailable: string;
  pasteImageUnavailable: string;
}

/**
 * Format session state for display
 */
export function formatSessionStatus(state: SessionState, lang: 'en' | 'ja'): string {
  const lines: string[] = [];

  // Status line
  if (state.status === 'success') {
    lines.push(getLabel('interactive.previousTask.success', lang));
  } else if (state.status === 'error') {
    lines.push(
      getLabel('interactive.previousTask.error', lang, {
        error: state.errorMessage!,
      }),
    );
  } else if (state.status === 'user_stopped') {
    lines.push(getLabel('interactive.previousTask.userStopped', lang));
  }

  // Workflow name
  lines.push(
    getLabel('interactive.previousTask.workflow', lang, {
      workflowName: state.workflowName,
    }),
  );

  // Timestamp
  const timestamp = new Date(state.timestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
  lines.push(
    getLabel('interactive.previousTask.timestamp', lang, {
      timestamp,
    }),
  );

  return lines.join('\n');
}

export function resolveLanguage(lang?: Language): 'en' | 'ja' {
  return lang === 'ja' ? 'ja' : 'en';
}

export { DEFAULT_INTERACTIVE_TOOLS } from './interactiveApplication.js';

/**
 * Build the summary prompt (used as both system prompt and user message).
 */
export {
  formatStepPreviews,
  type ConversationMessage,
  type WorkflowContext,
  type TaskHistorySummaryItem,
} from './interactive-summary.js';

export function buildSummaryPrompt(
  history: ConversationMessage[],
  userNote: string,
  lang: 'en' | 'ja',
  promptContext?: string,
  gherkin?: boolean,
): string;
export function buildSummaryPrompt(
  history: ConversationMessage[],
  hasSession: boolean,
  lang: 'en' | 'ja',
  noTranscriptNote: string,
  conversationLabel: string,
  workflowContext?: WorkflowContext,
  sourceContext?: string,
  promptContext?: string,
  gherkin?: boolean,
): string;
export function buildSummaryPrompt(
  history: ConversationMessage[],
  userNoteOrHasSession: string | boolean,
  lang: 'en' | 'ja',
  promptContextOrNoTranscript?: string,
  conversationLabelOrGherkin?: string | boolean,
  workflowContext?: WorkflowContext,
  sourceContext?: string,
  promptContext?: string,
  gherkin?: boolean,
): string {
  if (typeof userNoteOrHasSession === 'boolean') {
    return buildInteractiveSummaryPrompt(
      history,
      userNoteOrHasSession,
      lang,
      promptContextOrNoTranscript ?? '',
      typeof conversationLabelOrGherkin === 'string' ? conversationLabelOrGherkin : '',
      workflowContext,
      sourceContext,
      promptContext,
      gherkin,
    );
  }

  return buildConversationSummaryPrompt(
    history,
    userNoteOrHasSession,
    lang,
    promptContextOrNoTranscript,
    typeof conversationLabelOrGherkin === 'boolean' ? conversationLabelOrGherkin : false,
  );
}

/**
 * Run the interactive task input mode.
 *
 * Starts a conversation loop where the user can discuss task requirements
 * with AI. The conversation continues until:
 *   /go      → returns the conversation as a task
 *   /accept  → returns the latest assistant response as a task
 *   /cancel  → exits without executing
 *   Ctrl+D   → exits without executing
 */
export interface InteractiveModeOptions {
  /** Actions to exclude from the post-summary action selector. */
  excludeActions?: readonly SummaryActionValue[];
  /** CLI provider override for assistant mode */
  provider?: ProviderType;
  /** CLI model override for assistant mode */
  model?: string;
  /** Assistant conversation behavior. */
  assistantMode?: AssistantInteractiveMode;
}

export interface InteractiveSeedInput {
  /** Initial user task text supplied directly from CLI input. */
  userMessage?: string;
  /** Untrusted reference context loaded from PR/Issue sources. */
  sourceContext?: string;
  /** Images already associated with the seeded user input. */
  attachments?: InteractiveImageAttachment[];
}

export async function interactiveMode(
  cwd: string,
  initialInput?: InteractiveSeedInput,
  workflowContext?: WorkflowContext,
  sessionId?: string,
  runSessionContext?: RunSessionContext,
  options?: InteractiveModeOptions,
): Promise<InteractiveModeResult> {
  const assistantMode = options?.assistantMode ?? 'assistant';
  const { ctx, strategy } = createAssistantConversationPlan(cwd, {
    assistantMode,
    ...(workflowContext ? { workflowContext } : {}),
    ...(runSessionContext ? { runSessionContext } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(sessionId ? { sessionId } : {}),
  });

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);

  const excludeActions = options?.excludeActions;
  const selectAction = excludeActions?.length
    ? createPostSummaryActionSelector(ui.proposed, ui, excludeActions)
    : undefined;

  return runConversationLoop(cwd, ctx, {
    ...strategy,
    selectAction,
  }, workflowContext, initialInput);
}

export {
  type InteractiveModeAction,
  type InteractiveSummaryUIText,
  type PostSummaryAction,
  type SummaryActionLabels,
  type SummaryActionOption,
  type SummaryActionValue,
  selectPostSummaryAction,
  buildSummaryActionOptions,
  createPostSummaryActionSelector,
  selectSummaryAction,
  formatTaskHistorySummary,
  normalizeTaskHistorySummary,
  BASE_SUMMARY_ACTIONS,
} from './interactive-summary.js';

export interface InteractiveModeResult extends ImageAttachmentCleanupOwner {
  /** The action selected by the user */
  action: InteractiveModeAction;
  /** The assembled task text (only meaningful when action is not 'cancel') */
  task: string;
  /** Images pasted during interactive input and referenced by placeholder. */
  attachments?: InteractiveImageAttachment[];
}
