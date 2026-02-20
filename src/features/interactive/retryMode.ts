/**
 * Retry mode for failed tasks.
 *
 * Provides a dedicated conversation loop with failure context,
 * run session data, and piece structure injected into the system prompt.
 */

import {
  initializeSession,
  displayAndClearSessionState,
  runConversationLoop,
  type SessionContext,
  type ConversationStrategy,
} from './conversationLoop.js';
import {
  createSelectActionWithoutExecute,
  formatMovementPreviews,
  type PieceContext,
} from './interactive-summary.js';
import { resolveLanguage } from './interactive.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { resolveConfigValues } from '../../infra/config/index.js';
import type { InstructModeResult, InstructUIText } from '../tasks/list/instructMode.js';

/** Failure information for a retry task */
export interface RetryFailureInfo {
  readonly taskName: string;
  readonly taskContent: string;
  readonly createdAt: string;
  readonly failedMovement: string;
  readonly error: string;
  readonly lastMessage: string;
  readonly retryNote: string;
}

/** Run session reference data for retry prompt */
export interface RetryRunInfo {
  readonly logsDir: string;
  readonly reportsDir: string;
  readonly task: string;
  readonly piece: string;
  readonly status: string;
  readonly movementLogs: string;
  readonly reports: string;
}

/** Full retry context assembled by the caller */
export interface RetryContext {
  readonly failure: RetryFailureInfo;
  readonly branchName: string;
  readonly pieceContext: PieceContext;
  readonly run: RetryRunInfo | null;
  readonly previousOrderContent: string | null;
}

const RETRY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

/**
 * Convert RetryContext into template variable map.
 */
export function buildRetryTemplateVars(ctx: RetryContext, lang: 'en' | 'ja', previousOrderContent: string | null = null): Record<string, string | boolean> {
  const hasPiecePreview = !!ctx.pieceContext.movementPreviews?.length;
  const movementDetails = hasPiecePreview
    ? formatMovementPreviews(ctx.pieceContext.movementPreviews!, lang)
    : '';

  const hasRun = ctx.run !== null;
  return {
    taskName: ctx.failure.taskName,
    taskContent: ctx.failure.taskContent,
    branchName: ctx.branchName,
    createdAt: ctx.failure.createdAt,
    failedMovement: ctx.failure.failedMovement,
    failureError: ctx.failure.error,
    failureLastMessage: ctx.failure.lastMessage,
    retryNote: ctx.failure.retryNote,
    hasPiecePreview,
    pieceStructure: ctx.pieceContext.pieceStructure,
    movementDetails,
    hasRun,
    runLogsDir: hasRun ? ctx.run!.logsDir : '',
    runReportsDir: hasRun ? ctx.run!.reportsDir : '',
    runTask: hasRun ? ctx.run!.task : '',
    runPiece: hasRun ? ctx.run!.piece : '',
    runStatus: hasRun ? ctx.run!.status : '',
    runMovementLogs: hasRun ? ctx.run!.movementLogs : '',
    runReports: hasRun ? ctx.run!.reports : '',
    hasOrderContent: previousOrderContent !== null,
    orderContent: previousOrderContent ?? '',
  };
}

/**
 * Run retry mode conversation loop.
 *
 * Uses a dedicated system prompt with failure context, run session data,
 * and piece structure injected for the AI assistant.
 */
export async function runRetryMode(
  cwd: string,
  retryContext: RetryContext,
  previousOrderContent: string | null,
): Promise<InstructModeResult> {
  const globalConfig = resolveConfigValues(cwd, ['language', 'provider']);
  const lang = resolveLanguage(globalConfig.language);

  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }

  const baseCtx = initializeSession(cwd, 'retry');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'retry' };

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);

  const templateVars = buildRetryTemplateVars(retryContext, lang, previousOrderContent);
  const systemPrompt = loadTemplate('score_retry_system_prompt', ctx.lang, templateVars);

  const retryIntro = getLabel('retry.ui.intro', ctx.lang);
  const introLabel = ctx.lang === 'ja'
    ? `## リトライ: ${retryContext.failure.taskName}\n\nブランチ: ${retryContext.branchName}\n\n${retryIntro}`
    : `## Retry: ${retryContext.failure.taskName}\n\nBranch: ${retryContext.branchName}\n\n${retryIntro}`;

  const policyContent = loadTemplate('score_interactive_policy', ctx.lang, {});

  function injectPolicy(userMessage: string): string {
    const policyIntro = ctx.lang === 'ja'
      ? '以下のポリシーは行動規範です。必ず遵守してください。'
      : 'The following policy defines behavioral guidelines. Please follow them.';
    const reminderLabel = ctx.lang === 'ja'
      ? '上記の Policy セクションで定義されたポリシー規範を遵守してください。'
      : 'Please follow the policy guidelines defined in the Policy section above.';
    return `## Policy\n${policyIntro}\n\n${policyContent}\n\n---\n\n${userMessage}\n\n---\n**Policy Reminder:** ${reminderLabel}`;
  }

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: RETRY_TOOLS,
    transformPrompt: injectPolicy,
    introMessage: introLabel,
    selectAction: createSelectActionWithoutExecute(ui),
    previousOrderContent: previousOrderContent ?? undefined,
    enableRetryCommand: true,
  };

  const result = await runConversationLoop(cwd, ctx, strategy, retryContext.pieceContext, undefined);

  if (result.action === 'cancel') {
    return { action: 'cancel', task: '' };
  }

  return { action: result.action as InstructModeResult['action'], task: result.task };
}
