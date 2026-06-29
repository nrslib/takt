import {
  buildSummaryPrompt as buildInteractiveSummaryPrompt,
  type ConversationMessage,
  type WorkflowContext,
} from './interactive-summary.js';

export type { ConversationMessage, WorkflowContext };

export const DEFAULT_INTERACTIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

export function buildConversationSummaryPrompt(
  history: ConversationMessage[],
  userNote: string,
  lang: 'en' | 'ja',
  promptContext?: string,
): string {
  const trimmedNote = userNote.trim();
  const summaryHistory = trimmedNote
    ? [...history, { role: 'user' as const, content: trimmedNote }]
    : history;
  return buildInteractiveSummaryPrompt(
    summaryHistory,
    false,
    lang,
    '',
    lang === 'ja' ? '会話' : 'Conversation',
    undefined,
    undefined,
    promptContext,
  );
}
