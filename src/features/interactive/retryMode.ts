/**
 * Retry mode for failed tasks.
 *
 * Provides a dedicated conversation loop with failure context,
 * run session data, and workflow structure injected into the system prompt.
 */

import {
  displayAndClearSessionState,
  runConversationLoop,
  type SessionContext,
  type ConversationStrategy,
} from './conversationLoop.js';
import { initializeSession } from './sessionInitialization.js';
import {
  createSelectActionWithoutExecute,
  formatStepPreviews,
  type WorkflowContext,
} from './interactive-summary.js';
import { resolveLanguage } from './interactive.js';
import { buildInteractivePolicyPrompt } from './policyPrompt.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { resolveConfigValues } from '../../infra/config/index.js';
import type { InstructModeResult, InstructUIText } from '../tasks/list/instructMode.js';

/** Failure information for a retry task */
export interface RetryFailureInfo {
  readonly taskName: string;
  readonly taskContent: string;
  readonly createdAt: string;
  readonly failedStep: string;
  readonly error: string;
  readonly lastMessage: string;
  readonly retryNote: string;
}

/** Run session reference data for retry prompt */
export interface RetryRunInfo {
  readonly logsDir: string;
  readonly reportsDir: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly stepLogs: string;
  readonly reports: string;
}

/** Full retry context assembled by the caller */
export interface RetryContext {
  readonly failure: RetryFailureInfo;
  readonly branchName: string;
  readonly workflowContext: WorkflowContext;
  readonly run: RetryRunInfo | null;
  readonly previousOrderContent: string | null;
}

const RETRY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

/**
 * Convert RetryContext into template variable map.
 */
export function buildRetryTemplateVars(ctx: RetryContext, lang: 'en' | 'ja', previousOrderContent: string | null = null): Record<string, string | boolean> {
  const hasWorkflowPreview = !!ctx.workflowContext.stepPreviews?.length;
  const stepDetails =
    hasWorkflowPreview && ctx.workflowContext.stepPreviews
      ? formatStepPreviews(ctx.workflowContext.stepPreviews, lang)
      : '';

  const run = ctx.run;
  const hasRun = run !== null;
  return {
    taskName: ctx.failure.taskName,
    taskContent: ctx.failure.taskContent,
    branchName: ctx.branchName,
    createdAt: ctx.failure.createdAt,
    failedStep: ctx.failure.failedStep,
    failureError: ctx.failure.error,
    failureLastMessage: ctx.failure.lastMessage,
    retryNote: ctx.failure.retryNote,
    hasWorkflowPreview: hasWorkflowPreview,
    workflowStructure: ctx.workflowContext.workflowStructure,
    stepDetails,
    hasRun,
    runLogsDir: run !== null ? run.logsDir : '',
    runReportsDir: run !== null ? run.reportsDir : '',
    runTask: run !== null ? run.task : '',
    runWorkflow: run !== null ? run.workflow : '',
    runStatus: run !== null ? run.status : '',
    runStepLogs: run !== null ? run.stepLogs : '',
    runReports: run !== null ? run.reports : '',
    hasOrderContent: previousOrderContent !== null,
    orderContent: previousOrderContent ?? '',
  };
}

/**
 * Run retry mode conversation loop.
 *
 * Uses a dedicated system prompt with failure context, run session data,
 * and workflow structure injected for the AI assistant.
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

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: RETRY_TOOLS,
    transformPrompt: (userMessage: string, sourceContext?: string) =>
      buildInteractivePolicyPrompt(ctx.lang, userMessage, sourceContext),
    introMessage: introLabel,
    selectAction: createSelectActionWithoutExecute(ui),
    previousOrderContent: previousOrderContent ?? undefined,
    enableRetryCommand: true,
  };

  const result = await runConversationLoop(cwd, ctx, strategy, retryContext.workflowContext, undefined);

  if (result.action === 'cancel') {
    return { action: 'cancel', task: '' };
  }

  return { action: result.action as InstructModeResult['action'], task: result.task };
}
