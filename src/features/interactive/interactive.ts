/**
 * Interactive task input mode
 *
 * Allows users to refine task requirements through conversation with AI
 * before executing the task. Uses the same SDK call pattern as piece
 * execution (with onStream) to ensure compatibility.
 *
 * Commands:
 *   /go     - Confirm and execute the task
 *   /cancel - Cancel and exit
 */

import type { Language } from '../../core/models/index.js';
import {
  type SessionState,
} from '../../infra/config/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  initializeSession,
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';
import {
  type PieceContext,
  formatMovementPreviews,
  type InteractiveModeAction,
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

  // Piece name
  lines.push(
    getLabel('interactive.previousTask.piece', lang, {
      pieceName: state.pieceName,
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
  formatMovementPreviews,
  type ConversationMessage,
  type PieceContext,
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
export async function interactiveMode(
  cwd: string,
  initialInput?: string,
  pieceContext?: PieceContext,
  sessionId?: string,
  runSessionContext?: RunSessionContext,
): Promise<InteractiveModeResult> {
  const baseCtx = initializeSession(cwd, 'interactive');
  const ctx = sessionId ? { ...baseCtx, sessionId } : baseCtx;

  displayAndClearSessionState(cwd, ctx.lang);

  const hasPreview = !!pieceContext?.movementPreviews?.length;
  const hasRunSession = !!runSessionContext;
  const runPromptVars = hasRunSession
    ? formatRunSessionForPrompt(runSessionContext)
    : { runTask: '', runPiece: '', runStatus: '', runMovementLogs: '', runReports: '' };

  const systemPrompt = loadTemplate('score_interactive_system_prompt', ctx.lang, {
    hasPiecePreview: hasPreview,
    pieceStructure: pieceContext?.pieceStructure ?? '',
    movementDetails: hasPreview ? formatMovementPreviews(pieceContext!.movementPreviews!, ctx.lang) : '',
    hasRunSession,
    ...runPromptVars,
  });
  const policyContent = loadTemplate('score_interactive_policy', ctx.lang, {});
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);

  /**
   * Inject policy into user message for AI call.
   * Follows the same pattern as piece execution (perform_phase1_message.md).
   */
  function injectPolicy(userMessage: string): string {
    const policyIntro = ctx.lang === 'ja'
      ? '以下のポリシーは行動規範です。必ず遵守してください。'
      : 'The following policy defines behavioral guidelines. Please follow them.';
    const reminderLabel = ctx.lang === 'ja'
      ? '上記の Policy セクションで定義されたポリシー規範を遵守してください。'
      : 'Please follow the policy guidelines defined in the Policy section above.';
    return `## Policy\n${policyIntro}\n\n${policyContent}\n\n---\n\n${userMessage}\n\n---\n**Policy Reminder:** ${reminderLabel}`;
  }

  return runConversationLoop(cwd, ctx, {
    systemPrompt,
    allowedTools: DEFAULT_INTERACTIVE_TOOLS,
    transformPrompt: injectPolicy,
    introMessage: ui.intro,
  }, pieceContext, initialInput);
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
