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
} from '../../interactive/promptSections.js';
import { createSelectActionWithoutExecute, buildReplayHint } from '../../interactive/interactive-summary.js';
import { attachImageAttachmentCleanup } from '../../interactive/imageAttachments.js';
import { type RunSessionContext, formatRunSessionForPrompt } from '../../interactive/runSessionReader.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';

export type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';

const INSTRUCT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

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
  branchContext: string,
  branchName: string,
  taskName: string,
  taskContent: string,
  retryNote: string,
  lang: 'en' | 'ja',
  workflowContext?: WorkflowContext,
  runSessionContext?: RunSessionContext,
  previousOrderContent?: string | null,
): Record<string, string | boolean> {
  const hasWorkflowPreview = !!workflowContext?.stepPreviews?.length;
  const stepDetails = hasWorkflowPreview
    ? formatStepPreviews(workflowContext!.stepPreviews!, lang)
    : '';

  const hasRunSession = !!runSessionContext;
  const runPromptVars = hasRunSession
    ? formatRunSessionForPrompt(runSessionContext)
    : { runTask: '', runWorkflow: '', runStatus: '', runStepLogs: '', runReports: '' };

  return {
    taskName,
    taskContent,
    branchName,
    branchContext,
    retryNote,
    hasWorkflowPreview,
    workflowStructure: workflowContext?.workflowStructure ?? '',
    stepDetails,
    hasRunSession,
    ...runPromptVars,
    hasOrderContent: !!previousOrderContent,
    orderContent: previousOrderContent ?? '',
  };
}

export async function runInstructMode(
  cwd: string,
  branchContext: string,
  branchName: string,
  taskName: string,
  taskContent: string,
  retryNote: string,
  workflowContext?: WorkflowContext,
  runSessionContext?: RunSessionContext,
  previousOrderContent?: string | null,
): Promise<InstructModeResult> {
  const globalConfig = resolveWorkflowConfigValues(cwd, ['language', 'provider']);
  const lang = resolveLanguage(globalConfig.language);

  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }

  const baseCtx = initializeSession(cwd, 'instruct');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'instruct' };

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);

  const templateVars = buildInstructTemplateVars(
    branchContext, branchName, taskName, taskContent, retryNote, lang,
    workflowContext, runSessionContext, previousOrderContent,
  );
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

  const result = await runConversationLoop(cwd, ctx, strategy, workflowContext, undefined);

  return toInstructModeResult(result);
}
