/**
 * Instruct mode for branch-based tasks.
 *
 * Provides conversation loop for additional instructions on existing branches,
 * similar to interactive mode but with branch context and limited actions.
 */

import {
  initializeSession,
  displayAndClearSessionState,
  runConversationLoop,
  type SessionContext,
  type ConversationStrategy,
  type PostSummaryAction,
} from '../../interactive/conversationLoop.js';
import {
  resolveLanguage,
  buildSummaryActionOptions,
  selectSummaryAction,
  formatMovementPreviews,
  type PieceContext,
} from '../../interactive/interactive.js';
import { type RunSessionContext, formatRunSessionForPrompt } from '../../interactive/runSessionReader.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import { loadGlobalConfig } from '../../../infra/config/index.js';

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

function createSelectInstructAction(ui: InstructUIText): (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null> {
  return async (task: string, _lang: 'en' | 'ja'): Promise<PostSummaryAction | null> => {
    return selectSummaryAction(
      task,
      ui.proposed,
      ui.actionPrompt,
      buildSummaryActionOptions({
        execute: ui.actions.execute,
        saveTask: ui.actions.saveTask,
        continue: ui.actions.continue,
      }),
    );
  };
}

function buildInstructTemplateVars(
  branchContext: string,
  branchName: string,
  taskName: string,
  taskContent: string,
  retryNote: string,
  lang: 'en' | 'ja',
  pieceContext?: PieceContext,
  runSessionContext?: RunSessionContext,
): Record<string, string | boolean> {
  const hasPiecePreview = !!pieceContext?.movementPreviews?.length;
  const movementDetails = hasPiecePreview
    ? formatMovementPreviews(pieceContext!.movementPreviews!, lang)
    : '';

  const hasRunSession = !!runSessionContext;
  const runPromptVars = hasRunSession
    ? formatRunSessionForPrompt(runSessionContext)
    : { runTask: '', runPiece: '', runStatus: '', runMovementLogs: '', runReports: '' };

  return {
    taskName,
    taskContent,
    branchName,
    branchContext,
    retryNote,
    hasPiecePreview,
    pieceStructure: pieceContext?.pieceStructure ?? '',
    movementDetails,
    hasRunSession,
    ...runPromptVars,
  };
}

export async function runInstructMode(
  cwd: string,
  branchContext: string,
  branchName: string,
  taskName: string,
  taskContent: string,
  retryNote: string,
  pieceContext?: PieceContext,
  runSessionContext?: RunSessionContext,
): Promise<InstructModeResult> {
  const globalConfig = loadGlobalConfig();
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
    pieceContext, runSessionContext,
  );
  const systemPrompt = loadTemplate('score_instruct_system_prompt', ctx.lang, templateVars);

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
    allowedTools: INSTRUCT_TOOLS,
    transformPrompt: injectPolicy,
    introMessage: ui.intro,
    selectAction: createSelectInstructAction(ui),
  };

  const result = await runConversationLoop(cwd, ctx, strategy, pieceContext, undefined);

  if (result.action === 'cancel') {
    return { action: 'cancel', task: '' };
  }

  return { action: result.action as InstructModeAction, task: result.task };
}
