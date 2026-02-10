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
  type MovementPreview,
} from '../../infra/config/index.js';
import { selectOption } from '../../shared/prompt/index.js';
import { info, blankLine } from '../../shared/ui/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import {
  initializeSession,
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';

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
      })
    );
  } else if (state.status === 'user_stopped') {
    lines.push(getLabel('interactive.previousTask.userStopped', lang));
  }

  // Piece name
  lines.push(
    getLabel('interactive.previousTask.piece', lang, {
      pieceName: state.pieceName,
    })
  );

  // Timestamp
  const timestamp = new Date(state.timestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
  lines.push(
    getLabel('interactive.previousTask.timestamp', lang, {
      timestamp,
    })
  );

  return lines.join('\n');
}

export function resolveLanguage(lang?: Language): 'en' | 'ja' {
  return lang === 'ja' ? 'ja' : 'en';
}

/**
 * Format MovementPreview[] into a Markdown string for template injection.
 * Each movement is rendered with its persona and instruction content.
 */
export function formatMovementPreviews(previews: MovementPreview[], lang: 'en' | 'ja'): string {
  return previews.map((p, i) => {
    const toolsStr = p.allowedTools.length > 0
      ? p.allowedTools.join(', ')
      : (lang === 'ja' ? 'なし' : 'None');
    const editStr = p.canEdit
      ? (lang === 'ja' ? '可' : 'Yes')
      : (lang === 'ja' ? '不可' : 'No');
    const personaLabel = lang === 'ja' ? 'ペルソナ' : 'Persona';
    const instructionLabel = lang === 'ja' ? 'インストラクション' : 'Instruction';
    const toolsLabel = lang === 'ja' ? 'ツール' : 'Tools';
    const editLabel = lang === 'ja' ? '編集' : 'Edit';

    const lines = [
      `### ${i + 1}. ${p.name} (${p.personaDisplayName})`,
    ];
    if (p.personaContent) {
      lines.push(`**${personaLabel}:**`, p.personaContent);
    }
    if (p.instructionContent) {
      lines.push(`**${instructionLabel}:**`, p.instructionContent);
    }
    lines.push(`**${toolsLabel}:** ${toolsStr}`, `**${editLabel}:** ${editStr}`);
    return lines.join('\n');
  }).join('\n\n');
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Build the final task description from conversation history for executeTask.
 */
function buildTaskFromHistory(history: ConversationMessage[]): string {
  return history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
}

/**
 * Build the summary prompt (used as both system prompt and user message).
 * Renders the complete score_summary_system_prompt template with conversation data.
 * Returns empty string if there is no conversation to summarize.
 */
export function buildSummaryPrompt(
  history: ConversationMessage[],
  hasSession: boolean,
  lang: 'en' | 'ja',
  noTranscriptNote: string,
  conversationLabel: string,
  pieceContext?: PieceContext,
): string {
  let conversation = '';
  if (history.length > 0) {
    const historyText = buildTaskFromHistory(history);
    conversation = `${conversationLabel}\n${historyText}`;
  } else if (hasSession) {
    conversation = `${conversationLabel}\n${noTranscriptNote}`;
  } else {
    return '';
  }

  const hasPiece = !!pieceContext;
  const hasPreview = !!pieceContext?.movementPreviews?.length;
  const summaryMovementDetails = hasPreview
    ? `\n### ${lang === 'ja' ? '処理するエージェント' : 'Processing Agents'}\n${formatMovementPreviews(pieceContext!.movementPreviews!, lang)}`
    : '';
  return loadTemplate('score_summary_system_prompt', lang, {
    pieceInfo: hasPiece,
    pieceName: pieceContext?.name ?? '',
    pieceDescription: pieceContext?.description ?? '',
    movementDetails: summaryMovementDetails,
    conversation,
  });
}

export type PostSummaryAction = InteractiveModeAction | 'continue';

export async function selectPostSummaryAction(
  task: string,
  proposedLabel: string,
  ui: InteractiveUIText,
): Promise<PostSummaryAction | null> {
  blankLine();
  info(proposedLabel);
  console.log(task);

  return selectOption<PostSummaryAction>(ui.actionPrompt, [
    { label: ui.actions.execute, value: 'execute' },
    { label: ui.actions.createIssue, value: 'create_issue' },
    { label: ui.actions.saveTask, value: 'save_task' },
    { label: ui.actions.continue, value: 'continue' },
  ]);
}

export type InteractiveModeAction = 'execute' | 'save_task' | 'create_issue' | 'cancel';

export interface InteractiveModeResult {
  /** The action selected by the user */
  action: InteractiveModeAction;
  /** The assembled task text (only meaningful when action is not 'cancel') */
  task: string;
}

export interface PieceContext {
  /** Piece name (e.g. "minimal") */
  name: string;
  /** Piece description */
  description: string;
  /** Piece structure (numbered list of movements) */
  pieceStructure: string;
  /** Movement previews (persona + instruction content for first N movements) */
  movementPreviews?: MovementPreview[];
}

export const DEFAULT_INTERACTIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

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
): Promise<InteractiveModeResult> {
  const baseCtx = initializeSession(cwd, 'interactive');
  const ctx = sessionId ? { ...baseCtx, sessionId } : baseCtx;

  displayAndClearSessionState(cwd, ctx.lang);

  const hasPreview = !!pieceContext?.movementPreviews?.length;
  const systemPrompt = loadTemplate('score_interactive_system_prompt', ctx.lang, {
    hasPiecePreview: hasPreview,
    pieceStructure: pieceContext?.pieceStructure ?? '',
    movementDetails: hasPreview ? formatMovementPreviews(pieceContext!.movementPreviews!, ctx.lang) : '',
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
