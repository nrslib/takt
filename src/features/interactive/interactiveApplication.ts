import {
  buildSummaryPrompt as buildInteractiveSummaryPrompt,
  type ConversationMessage,
  type WorkflowContext,
} from './interactive-summary.js';
import type { InlineUtteranceSource } from './promptSections.js';

export type { ConversationMessage, WorkflowContext };

export const DEFAULT_INTERACTIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

/** Context the caller already resolved and wants reflected in the summary prompt. */
export interface ConversationSummaryContext {
  userNoteSource?: InlineUtteranceSource;
  workflowContext?: WorkflowContext;
  sourceContext?: string;
  /** Whether a separate handoff transcript will be quoted in the user prompt. */
  hasReferenceHistory?: boolean;
  /**
   * Set when a provider session is being continued but no local transcript
   * exists yet — resuming and summarizing straight away must still describe the
   * conversation instead of reporting that there is none.
   */
  resumedSessionNote?: string;
}

export function buildConversationSummaryPrompt(
  history: ConversationMessage[],
  userNote: string,
  lang: 'en' | 'ja',
  promptContext?: string,
  formalSpec = false,
  context?: ConversationSummaryContext,
  formalSpecComments = true,
): string {
  const resumedSessionNote = context?.resumedSessionNote;
  const hasSession = resumedSessionNote !== undefined;
  return buildInteractiveSummaryPrompt(
    history,
    hasSession,
    lang,
    hasSession ? resumedSessionNote : '',
    lang === 'ja' ? '会話' : 'Conversation',
    context?.workflowContext,
    context?.sourceContext,
    promptContext,
    formalSpec,
    context?.hasReferenceHistory === true,
    formalSpecComments,
    userNote,
    context?.userNoteSource,
  );
}
