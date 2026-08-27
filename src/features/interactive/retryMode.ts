/**
 * Retry mode for failed tasks.
 *
 * Provides a dedicated conversation loop with failure context,
 * run session data, and workflow structure injected into the system prompt.
 */

import {
  displayAndClearSessionState,
  runConversationLoop,
  type ConversationStrategy,
} from './conversationLoop.js';
import {
  createSelectActionWithoutExecute,
  buildSummaryActionOptions,
  formatStepPreviews,
  selectSummaryAction,
  type WorkflowContext,
  type PostSummaryAction,
} from './interactive-summary.js';
import { getLabelObject } from '../../shared/i18n/index.js';
import type { InstructModeResult, InstructUIText } from './instructModeTypes.js';
import { attachImageAttachmentCleanup } from './imageAttachments.js';
import { runTuiTaskConversation } from '../tui/runTuiTask.js';
import {
  renderPullRequestContext,
  type PullRequestContext,
} from '../../core/workflow/pr-context.js';
import { hasInteractiveTerminal } from '../../shared/utils/index.js';
import { createRetryConversationPlan } from './taskActionConversationPlan.js';

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
  readonly prContext?: PullRequestContext;
}

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
    hasPrContext: ctx.prContext !== undefined,
    prContextText: ctx.prContext ? renderPullRequestContext(ctx.prContext, lang) : '',
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
  reviseOrder: boolean,
): Promise<InstructModeResult> {
  const plan = createRetryConversationPlan(cwd, retryContext, { reviseOrder });
  const ctx = plan.ctx;

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);
  const strategy: ConversationStrategy = {
    ...plan.strategy,
    selectAction: createSelectAction(ui),
  };

  const result = hasInteractiveTerminal()
    ? await runTuiTaskConversation({
      cwd,
      plan: { ctx, strategy },
      workflowContext: retryContext.workflowContext,
    })
    : await runConversationLoop(cwd, ctx, strategy, retryContext.workflowContext, undefined);

  if (result.action === 'cancel') {
    return attachImageAttachmentCleanup({
      action: 'cancel',
      task: '',
      ...(result.source ? { source: result.source } : {}),
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }, result.cleanupAttachments);
  }

  return attachImageAttachmentCleanup({
    action: result.action as InstructModeResult['action'],
    task: result.task,
    ...(result.source ? { source: result.source } : {}),
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }, result.cleanupAttachments);
}

export async function runTaskRetryMode(
  cwd: string,
  retryContext: RetryContext,
): Promise<InstructModeResult> {
  return runRetryConversation(cwd, retryContext, createSelectActionWithoutExecute, true);
}

export async function runDirectRetryMode(
  cwd: string,
  retryContext: RetryContext,
): Promise<InstructModeResult> {
  return runRetryConversation(cwd, retryContext, createDirectRetrySelectAction, false);
}
