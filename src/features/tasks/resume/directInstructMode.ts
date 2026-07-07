import {
  displayAndClearSessionState,
  runConversationLoop,
  type ConversationStrategy,
  type SessionContext,
} from '../../interactive/conversationLoop.js';
import { initializeSession } from '../../interactive/sessionInitialization.js';
import {
  buildReplayHint,
  formatStepPreviews,
  type PostSummaryAction,
  type WorkflowContext,
} from '../../interactive/interactive-summary.js';
import { resolveLanguage } from '../../interactive/interactive.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
} from '../../interactive/promptSections.js';
import { formatRunSessionForPrompt, type RunSessionContext } from '../../interactive/runSessionReader.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import { selectOption } from '../../../shared/prompt/index.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { blankLine, info } from '../../../shared/ui/index.js';
import { attachImageAttachmentCleanup } from '../../interactive/imageAttachments.js';
import type { InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';

export interface DirectInstructModeOptions {
  readonly cwd: string;
  readonly runSlug: string;
  readonly taskContent: string;
  readonly workflowContext: WorkflowContext;
  readonly runSessionContext: RunSessionContext;
  readonly previousOrderContent: string | null;
}

const DIRECT_INSTRUCT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

function buildDirectInstructTemplateVars(
  options: DirectInstructModeOptions,
  lang: 'en' | 'ja',
): Record<string, string | boolean> {
  const hasWorkflowPreview = options.workflowContext.stepPreviews !== undefined
    && options.workflowContext.stepPreviews.length > 0;
  const runPromptVars = formatRunSessionForPrompt(options.runSessionContext);

  return {
    runSlug: options.runSlug,
    taskContent: options.taskContent,
    hasWorkflowPreview,
    workflowStructure: options.workflowContext.workflowStructure,
    stepDetails: hasWorkflowPreview
      ? formatStepPreviews(options.workflowContext.stepPreviews!, lang)
      : '',
    ...runPromptVars,
    hasOrderContent: options.previousOrderContent !== null,
    orderContent: options.previousOrderContent ?? '',
  };
}

function createDirectSelectAction(
  ui: InstructUIText,
): (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null> {
  return async (task: string): Promise<PostSummaryAction | null> => {
    blankLine();
    info(ui.proposed);
    info(task);
    return selectOption(ui.actionPrompt, [
      { label: ui.actions.execute, value: 'execute' },
      { label: ui.actions.continue, value: 'continue' },
    ]);
  };
}

export async function runDirectInstructMode(
  options: DirectInstructModeOptions,
): Promise<InstructModeResult> {
  const globalConfig = resolveWorkflowConfigValues(options.cwd, ['language', 'provider']);
  const lang = resolveLanguage(globalConfig.language);

  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }

  const baseCtx = initializeSession(options.cwd, 'instruct');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'instruct' };
  displayAndClearSessionState(options.cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);
  const systemPrompt = prependSourceContextGuardToSystemPrompt(
    ctx.lang,
    loadTemplate(
      'score_direct_instruct_system_prompt',
      ctx.lang,
      buildDirectInstructTemplateVars(options, ctx.lang),
    ),
  );
  const replayHint = buildReplayHint(ctx.lang, options.previousOrderContent !== null);

  const strategy: ConversationStrategy = {
    systemPrompt,
    allowedTools: DIRECT_INSTRUCT_TOOLS,
    transformPrompt: (userMessage: string, sourceContext?: string) =>
      prependSourceContext(ctx.lang, userMessage, sourceContext),
    introMessage: `${ui.intro}${replayHint}`,
    selectAction: createDirectSelectAction(ui),
    previousOrderContent: options.previousOrderContent ?? undefined,
  };

  const result = await runConversationLoop(options.cwd, ctx, strategy, options.workflowContext, undefined);
  if (result.action === 'cancel') {
    return attachImageAttachmentCleanup({
      action: 'cancel',
      task: '',
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }, result.cleanupAttachments);
  }
  return attachImageAttachmentCleanup({
    action: 'execute',
    task: result.task,
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }, result.cleanupAttachments);
}
