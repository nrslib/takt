/**
 * Type definitions for interactive summary.
 */

import type { MovementPreview } from '../../infra/config/index.js';

export type TaskHistoryLocale = 'en' | 'ja';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TaskHistorySummaryItem {
  worktreeId: string;
  status: 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt: string;
  finalResult: string;
  failureSummary: string | undefined;
  logKey: string;
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
  /** Recent task history for conversation context */
  taskHistory?: TaskHistorySummaryItem[];
}

export type InteractiveModeAction = 'execute' | 'save_task' | 'create_issue' | 'cancel';

export type PostSummaryAction = InteractiveModeAction | 'continue';

export type SummaryActionValue = 'execute' | 'create_issue' | 'save_task' | 'continue';

export interface SummaryActionOption {
  label: string;
  value: SummaryActionValue;
}

export type SummaryActionLabels = {
  execute: string;
  createIssue?: string;
  saveTask: string;
  continue: string;
};

export const BASE_SUMMARY_ACTIONS: readonly SummaryActionValue[] = [
  'execute',
  'save_task',
  'continue',
];

export interface InteractiveSummaryUIText {
  actionPrompt: string;
  actions: {
    execute: string;
    createIssue: string;
    saveTask: string;
    continue: string;
  };
}

/** UI labels required by createSelectActionWithoutExecute */
export interface ActionWithoutExecuteUIText {
  proposed: string;
  actionPrompt: string;
  actions: {
    execute: string;
    saveTask: string;
    continue: string;
  };
}
