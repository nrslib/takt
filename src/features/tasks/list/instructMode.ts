/**
 * Instruct mode for branch-based tasks.
 *
 * Provides conversation loop for additional instructions on existing branches,
 * similar to interactive mode but with branch context and limited actions.
 */

import {
  displayAndClearSessionState,
  runConversationLoop,
  type SessionContext,
  type ConversationStrategy,
} from '../../interactive/conversationLoop.js';
import { initializeSession } from '../../interactive/sessionInitialization.js';
import {
  resolveLanguage,
  formatStepPreviews,
  type InteractiveModeResult,
  type WorkflowContext,
} from '../../interactive/interactive.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
  formatLiteralBlock,
} from '../../interactive/promptSections.js';
import { createSelectActionWithoutExecute, buildReplayHint } from '../../interactive/interactive-summary.js';
import { attachImageAttachmentCleanup } from '../../interactive/imageAttachments.js';
import { runTuiTaskConversation } from '../../tui/runTuiTask.js';
import { type RunSessionContext, formatRunSessionForPrompt } from '../../interactive/runSessionReader.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';
import { renderPullRequestContext, type PullRequestContext } from '../../../core/workflow/pr-context.js';

export type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';

const INSTRUCT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

export interface InstructModeOptions {
  readonly cwd: string;
  readonly branchContext: string;
  readonly branchName: string;
  readonly taskName: string;
  readonly taskContent: string;
  readonly retryNote: string;
  readonly workflowContext?: WorkflowContext;
  readonly runSessionContext?: RunSessionContext;
  readonly previousOrderContent?: string | null;
  readonly prContext?: PullRequestContext;
  readonly failedContext?: FailedInstructContext;
}

export interface FailedInstructContext {
  readonly reportSummary: string;
  readonly worktreeSummary: string;
}

function toInstructModeResult(result: InteractiveModeResult): InstructModeResult {
  if (result.action === 'cancel') {
    return attachImageAttachmentCleanup({
      action: 'cancel',
      task: '',
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }, result.cleanupAttachments);
  }

  return attachImageAttachmentCleanup({
    action: result.action as InstructModeAction,
    task: result.task,
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }, result.cleanupAttachments);
}

function buildInstructTemplateVars(
  options: InstructModeOptions,
  lang: 'en' | 'ja',
): Record<string, string | boolean> {
  const {
    branchContext,
    branchName,
    taskName,
    taskContent,
    retryNote,
    workflowContext,
    runSessionContext,
    previousOrderContent,
    prContext,
    failedContext,
  } = options;
  const hasWorkflowPreview = !!workflowContext?.stepPreviews?.length;
  const stepDetails = hasWorkflowPreview
    ? formatStepPreviews(workflowContext!.stepPreviews!, lang)
    : '';

  const hasRunSession = !!runSessionContext;
  const runPromptVars = hasRunSession
    ? formatRunSessionForPrompt(runSessionContext)
    : { runTask: '', runWorkflow: '', runStatus: '', runStepLogs: '', runReports: '' };
  const reportSummary = failedContext?.reportSummary.length
    ? formatLiteralBlock(failedContext.reportSummary)
    : '';
  const worktreeSummary = failedContext?.worktreeSummary.length
    ? formatLiteralBlock(failedContext.worktreeSummary)
    : '';

  return {
    taskName,
    taskContent,
    branchName,
    branchContext: branchContext.length > 0 ? formatLiteralBlock(branchContext) : '',
    retryNote,
    hasWorkflowPreview,
    workflowStructure: workflowContext?.workflowStructure ?? '',
    stepDetails,
    hasRunSession,
    ...runPromptVars,
    hasOrderContent: !!previousOrderContent,
    orderContent: previousOrderContent ?? '',
    hasPrContext: prContext !== undefined,
    prContextText: prContext ? renderPullRequestContext(prContext, lang) : '',
    hasFailedContext: reportSummary.length > 0 || worktreeSummary.length > 0,
    hasReportSummary: reportSummary.length > 0,
    hasWorktreeSummary: worktreeSummary.length > 0,
    reportSummary,
    worktreeSummary,
  };
}

/**
 * A terminal gets the Ink conversation; piped input keeps the readline loop that
 * the non-interactive callers and the E2E suite depend on.
 */
function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function runInstructMode(
  options: InstructModeOptions,
): Promise<InstructModeResult> {
  const {
    cwd,
    workflowContext,
    previousOrderContent,
  } = options;
  const globalConfig = resolveWorkflowConfigValues(cwd, ['language']);
  const lang = resolveLanguage(globalConfig.language);

  const baseCtx = initializeSession(cwd, 'instruct');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'instruct' };

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);

  const templateVars = buildInstructTemplateVars(options, lang);
  const systemPrompt = prependSourceContextGuardToSystemPrompt(
    ctx.lang,
    loadTemplate('score_instruct_system_prompt', ctx.lang, templateVars),
  );

  const replayHint = buildReplayHint(ctx.lang, !!previousOrderContent);

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: INSTRUCT_TOOLS,
    transformPrompt: (userMessage: string, sourceContext?: string) =>
      prependSourceContext(ctx.lang, userMessage, sourceContext),
    introMessage: `${ui.intro}${replayHint}`,
    selectAction: createSelectActionWithoutExecute(ui),
    previousOrderContent: previousOrderContent ?? undefined,
  };

  const result = hasInteractiveTerminal()
    ? await runTuiTaskConversation({ cwd, plan: { ctx, strategy }, workflowContext })
    : await runConversationLoop(cwd, ctx, strategy, workflowContext, undefined);

  return toInstructModeResult(result);
}
