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
  buildSummaryActionOptions,
  formatStepPreviews,
  selectSummaryAction,
  type WorkflowContext,
  type PostSummaryAction,
} from './interactive-summary.js';
import { resolveLanguage } from './interactive.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from './promptSections.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { resolveConfigValues } from '../../infra/config/index.js';
import type { InstructModeResult, InstructUIText } from './instructModeTypes.js';
import { attachImageAttachmentCleanup } from './imageAttachments.js';

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

export type RetrySubjectKind = 'branch' | 'run';

export interface RetrySubject {
  readonly kind: RetrySubjectKind;
  readonly value: string;
}

/** Full retry context assembled by the caller */
export interface RetryContext {
  readonly failure: RetryFailureInfo;
  readonly subject: RetrySubject;
  readonly workflowContext: WorkflowContext;
  readonly run: RetryRunInfo | null;
  readonly previousOrderContent: string | null;
}

const RETRY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

type RetrySelectAction = (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>;
type RetrySelectActionFactory = (ui: InstructUIText) => RetrySelectAction;

function formatRetrySubjectLabel(kind: RetrySubjectKind, lang: 'en' | 'ja'): string {
  if (kind === 'run') {
    return 'Run';
  }
  return lang === 'ja' ? 'ブランチ' : 'Branch';
}

export function buildRetryTemplateVars(ctx: RetryContext, lang: 'en' | 'ja'): Record<string, string | boolean> {
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
    subjectLabel: formatRetrySubjectLabel(ctx.subject.kind, lang),
    subjectValue: ctx.subject.value,
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
    hasOrderContent: ctx.previousOrderContent !== null,
    orderContent: ctx.previousOrderContent ?? '',
  };
}

function createDirectRetrySelectAction(
  ui: InstructUIText,
): (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null> {
  return async (task: string): Promise<PostSummaryAction | null> =>
    selectSummaryAction(
      task,
      ui.proposed,
      ui.actionPrompt,
      buildSummaryActionOptions(
        {
          execute: ui.actions.execute,
          saveTask: ui.actions.saveTask,
          continue: ui.actions.continue,
        },
        [],
        ['save_task'],
      ),
    );
}

async function runRetryConversation(
  cwd: string,
  retryContext: RetryContext,
  createSelectAction: RetrySelectActionFactory,
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

  const templateVars = buildRetryTemplateVars(retryContext, lang);
  const systemPrompt = prependSourceContextGuardToSystemPrompt(
    ctx.lang,
    loadTemplate('score_retry_system_prompt', ctx.lang, templateVars),
  );

  const retryIntro = getLabel('retry.ui.intro', ctx.lang);
  const subjectLabel = formatRetrySubjectLabel(retryContext.subject.kind, ctx.lang);
  const introLabel = ctx.lang === 'ja'
    ? `## リトライ: ${retryContext.failure.taskName}\n\n${subjectLabel}: ${retryContext.subject.value}\n\n${retryIntro}`
    : `## Retry: ${retryContext.failure.taskName}\n\n${subjectLabel}: ${retryContext.subject.value}\n\n${retryIntro}`;

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: RETRY_TOOLS,
    transformPrompt: (userMessage: string, sourceContext?: string) =>
      prependSourceContext(ctx.lang, userMessage, sourceContext),
    introMessage: introLabel,
    selectAction: createSelectAction(ui),
    previousOrderContent: retryContext.previousOrderContent ?? undefined,
    enableRetryCommand: true,
  };

  const result = await runConversationLoop(cwd, ctx, strategy, retryContext.workflowContext, undefined);

  if (result.action === 'cancel') {
    return attachImageAttachmentCleanup({
      action: 'cancel',
      task: '',
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }, result.cleanupAttachments);
  }

  return attachImageAttachmentCleanup({
    action: result.action as InstructModeResult['action'],
    task: result.task,
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }, result.cleanupAttachments);
}

export async function runTaskRetryMode(
  cwd: string,
  retryContext: RetryContext,
): Promise<InstructModeResult> {
  return runRetryConversation(cwd, retryContext, createSelectActionWithoutExecute);
}

export async function runDirectRetryMode(
  cwd: string,
  retryContext: RetryContext,
): Promise<InstructModeResult> {
  return runRetryConversation(cwd, retryContext, createDirectRetrySelectAction);
}
