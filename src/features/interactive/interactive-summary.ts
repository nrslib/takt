/**
 * Interactive summary helpers.
 */

import { loadTemplate } from '../../shared/prompts/index.js';
import { type MovementPreview } from '../../infra/config/index.js';
import { selectOption } from '../../shared/prompt/index.js';
import { blankLine, info } from '../../shared/ui/index.js';

type TaskHistoryLocale = 'en' | 'ja';

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

export function formatMovementPreviews(previews: MovementPreview[], lang: TaskHistoryLocale): string {
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

function normalizeDateTime(value: string): string {
  return value.trim() === '' ? 'N/A' : value;
}

function normalizeTaskStatus(status: TaskHistorySummaryItem['status'], lang: TaskHistoryLocale): string {
  return status === 'completed'
    ? (lang === 'ja' ? '完了' : 'completed')
    : status === 'failed'
      ? (lang === 'ja' ? '失敗' : 'failed')
      : (lang === 'ja' ? '中断' : 'interrupted');
}

export function normalizeTaskHistorySummary(
  items: TaskHistorySummaryItem[],
  lang: TaskHistoryLocale,
): TaskHistorySummaryItem[] {
  return items.map((task) => ({
    ...task,
    startedAt: normalizeDateTime(task.startedAt),
    completedAt: normalizeDateTime(task.completedAt),
    finalResult: normalizeTaskStatus(task.status, lang),
  }));
}

function formatTaskHistoryItem(item: TaskHistorySummaryItem, lang: TaskHistoryLocale): string {
  const statusLabel = normalizeTaskStatus(item.status, lang);
  const failureSummaryLine = item.failureSummary
    ? `${lang === 'ja' ? '  - 失敗要約' : '  - Failure summary'}: ${item.failureSummary}\n`
    : '';
  const lines = [
    `- ${lang === 'ja' ? '実行ID' : 'Worktree ID'}: ${item.worktreeId}`,
    `  - ${lang === 'ja' ? 'ステータス' : 'Status'}: ${statusLabel}`,
    `  - ${lang === 'ja' ? '開始/終了' : 'Start/End'}: ${item.startedAt} / ${item.completedAt}`,
    `  - ${lang === 'ja' ? '最終結果' : 'Final result'}: ${item.finalResult}`,
    `  - ${lang === 'ja' ? 'ログ参照' : 'Log key'}: ${item.logKey}`,
    failureSummaryLine,
  ];
  return lines.join('\n').replace(/\n+$/, '');
}

export function formatTaskHistorySummary(taskHistory: TaskHistorySummaryItem[], lang: TaskHistoryLocale): string {
  if (taskHistory.length === 0) {
    return '';
  }

  const normalizedTaskHistory = normalizeTaskHistorySummary(taskHistory, lang);
  const heading = lang === 'ja'
    ? '## 実行履歴'
    : '## Task execution history';
  const details = normalizedTaskHistory.map((item) => formatTaskHistoryItem(item, lang)).join('\n\n');
  return `${heading}\n${details}`;
}

function buildTaskFromHistory(history: ConversationMessage[]): string {
  return history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
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
  const summaryTaskHistory = pieceContext?.taskHistory?.length
    ? formatTaskHistorySummary(pieceContext.taskHistory, lang)
    : '';

  return loadTemplate('score_summary_system_prompt', lang, {
    pieceInfo: hasPiece,
    pieceName: pieceContext?.name ?? '',
    pieceDescription: pieceContext?.description ?? '',
    movementDetails: summaryMovementDetails,
    taskHistory: summaryTaskHistory,
    conversation,
  });
}

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

export type InteractiveModeAction = 'execute' | 'save_task' | 'create_issue' | 'cancel';

export interface InteractiveSummaryUIText {
  actionPrompt: string;
  actions: {
    execute: string;
    createIssue: string;
    saveTask: string;
    continue: string;
  };
}

export function buildSummaryActionOptions(
  labels: SummaryActionLabels,
  append: readonly SummaryActionValue[] = [],
): SummaryActionOption[] {
  const order = [...BASE_SUMMARY_ACTIONS, ...append];
  const seen = new Set<SummaryActionValue>();
  const options: SummaryActionOption[] = [];

  for (const action of order) {
    if (seen.has(action)) {
      continue;
    }
    seen.add(action);

    if (action === 'execute') {
      options.push({ label: labels.execute, value: action });
      continue;
    }
    if (action === 'create_issue') {
      if (labels.createIssue) {
        options.push({ label: labels.createIssue, value: action });
      }
      continue;
    }
    if (action === 'save_task') {
      options.push({ label: labels.saveTask, value: action });
      continue;
    }
    options.push({ label: labels.continue, value: action });
  }

  return options;
}

export function selectSummaryAction(
  task: string,
  proposedLabel: string,
  actionPrompt: string,
  options: SummaryActionOption[],
): Promise<PostSummaryAction | null> {
  blankLine();
  info(proposedLabel);
  console.log(task);

  return selectOption<PostSummaryAction>(actionPrompt, options);
}

export function selectPostSummaryAction(
  task: string,
  proposedLabel: string,
  ui: InteractiveSummaryUIText,
): Promise<PostSummaryAction | null> {
  return selectSummaryAction(
    task,
    proposedLabel,
    ui.actionPrompt,
    buildSummaryActionOptions(
      {
        execute: ui.actions.execute,
        createIssue: ui.actions.createIssue,
        saveTask: ui.actions.saveTask,
        continue: ui.actions.continue,
      },
      ['create_issue'],
    ),
  );
}
