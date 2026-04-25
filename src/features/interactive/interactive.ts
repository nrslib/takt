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

import type { Language } from '../../core/models/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import {
  type SessionState,
} from '../../infra/config/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';
import { buildInteractivePolicyPrompt } from './policyPrompt.js';
import { initializeSession } from './sessionInitialization.js';
import {
  type WorkflowContext,
  formatStepPreviews,
  type InteractiveModeAction,
  type SummaryActionValue,
  type PostSummaryAction,
  buildSummaryActionOptions,
  selectSummaryAction,
} from './interactive-summary.js';
import { type RunSessionContext, formatRunSessionForPrompt } from './runSessionReader.js';

/** Shape of interactive UI text */
export interface InteractiveUIText {
  intro: string;
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
  playNoTask: string;
  retryNoOrder: string;
  retryUnavailable: string;
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

/** Default toolset for interactive mode */
export const DEFAULT_INTERACTIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

/**
 * Build the summary prompt (used as both system prompt and user message).
 */
export {
  buildSummaryPrompt,
  formatStepPreviews,
  type ConversationMessage,
  type WorkflowContext,
  type TaskHistorySummaryItem,
} from './interactive-summary.js';

/**
 * Run the interactive task input mode.
 *
 * Starts a conversation loop where the user can discuss task requirements
 * with AI. The conversation continues until:
 *   /go     → returns the conversation as a task
 *   /cancel → exits without executing
 *   Ctrl+D  → exits without executing
 */
export interface InteractiveModeOptions {
  /** Actions to exclude from the post-summary action selector. */
  excludeActions?: readonly SummaryActionValue[];
  /** CLI provider override for assistant mode */
  provider?: ProviderType;
  /** CLI model override for assistant mode */
  model?: string;
}

export interface InteractiveSeedInput {
  /** Initial user task text supplied directly from CLI input. */
  userMessage?: string;
  /** Untrusted reference context loaded from PR/Issue sources. */
  sourceContext?: string;
}

export async function interactiveMode(
  cwd: string,
  initialInput?: InteractiveSeedInput,
  workflowContext?: WorkflowContext,
  sessionId?: string,
  runSessionContext?: RunSessionContext,
  options?: InteractiveModeOptions,
): Promise<InteractiveModeResult> {
  const baseCtx = initializeSession(cwd, 'interactive', {
    provider: options?.provider,
    model: options?.model,
  });
  const ctx = sessionId ? { ...baseCtx, sessionId } : baseCtx;

  displayAndClearSessionState(cwd, ctx.lang);

  const hasPreview = !!workflowContext?.stepPreviews?.length;
  const hasRunSession = !!runSessionContext;
  const runPromptVars = hasRunSession
    ? formatRunSessionForPrompt(runSessionContext)
    : { runTask: '', runWorkflow: '', runStatus: '', runStepLogs: '', runReports: '' };

  const systemPrompt = loadTemplate('score_interactive_system_prompt', ctx.lang, {
    hasWorkflowPreview: hasPreview,
    workflowStructure: workflowContext?.workflowStructure ?? '',
    stepDetails: hasPreview ? formatStepPreviews(workflowContext!.stepPreviews!, ctx.lang) : '',
    hasRunSession,
    ...runPromptVars,
  });
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);

  const excludeActions = options?.excludeActions;
  const selectAction = excludeActions?.length
    ? (task: string): Promise<PostSummaryAction | null> =>
        selectSummaryAction(
          task,
          ui.proposed,
          ui.actionPrompt,
          buildSummaryActionOptions(
            {
              execute: ui.actions.execute,
              createIssue: ui.actions.createIssue,
              saveTask: ui.actions.saveTask,
              continue: ui.actions.continue,
            },
            ['create_issue'],
            excludeActions,
          ),
        )
    : undefined;

  return runConversationLoop(cwd, ctx, {
    systemPrompt,
    allowedTools: DEFAULT_INTERACTIVE_TOOLS,
    transformPrompt: (userMessage: string, sourceContext?: string) =>
      buildInteractivePolicyPrompt(ctx.lang, userMessage, sourceContext),
    introMessage: ui.intro,
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
  selectSummaryAction,
  formatTaskHistorySummary,
  normalizeTaskHistorySummary,
  BASE_SUMMARY_ACTIONS,
} from './interactive-summary.js';

export interface InteractiveModeResult {
  /** The action selected by the user */
  action: InteractiveModeAction;
  /** The assembled task text (only meaningful when action is not 'cancel') */
  task: string;
}
