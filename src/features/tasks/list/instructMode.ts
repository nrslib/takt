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
  type WorkflowContext,
} from '../../interactive/interactive.js';
import { buildInteractivePolicyPrompt } from '../../interactive/policyPrompt.js';
import { createSelectActionWithoutExecute, buildReplayHint } from '../../interactive/interactive-summary.js';
import { type RunSessionContext, formatRunSessionForPrompt } from '../../interactive/runSessionReader.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';

export type InstructModeAction = 'execute' | 'save_task' | 'cancel';

export interface InstructModeResult {
  action: InstructModeAction;
  task: string;
}

export interface InstructUIText {
  intro: string;
  resume: string;
  noConversation: string;
  summarizeFailed: string;
  continuePrompt: string;
  proposed: string;
  actionPrompt: string;
  actions: {
    execute: string;
    saveTask: string;
    continue: string;
  };
  cancelled: string;
}

const INSTRUCT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

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
  const systemPrompt = loadTemplate('score_instruct_system_prompt', ctx.lang, templateVars);

  const replayHint = buildReplayHint(ctx.lang, !!previousOrderContent);

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: INSTRUCT_TOOLS,
    transformPrompt: (userMessage: string) => buildInteractivePolicyPrompt(ctx.lang, userMessage),
    introMessage: `${ui.intro}${replayHint}`,
    selectAction: createSelectActionWithoutExecute(ui),
    previousOrderContent: previousOrderContent ?? undefined,
  };

  const result = await runConversationLoop(cwd, ctx, strategy, workflowContext, undefined);

  if (result.action === 'cancel') {
    return { action: 'cancel', task: '' };
  }

  return { action: result.action as InstructModeAction, task: result.task };
}
