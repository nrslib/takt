/**
 * Shared retry/instruct conversation plans.
 *
 * A front-end supplies the transport (readline, Ink, or Web session) and may
 * add its own selectors.  Prompt construction and the execution contract are
 * kept here so those front-ends cannot drift apart.
 */
import type { ConversationPlan } from './conversationPlan.js';
import {
  type ConversationStrategy,
  type SessionContext,
} from './conversationLoop.js';
import { initializeSession } from './sessionInitialization.js';
import { resolveLanguage } from './interactive.js';
import {
  resolveConfigValues,
  resolveWorkflowConfigValues,
} from '../../infra/config/index.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from './taskInstructionFormat.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import type { InstructUIText } from './instructModeTypes.js';
import {
  prependSourceContext,
  prependSourceContextGuardToSystemPrompt,
  formatLiteralBlock,
} from './promptSections.js';
import { formatStepPreviews } from './interactive-summary.js';
import { formatRunSessionForPrompt, type RunSessionContext } from './runSessionReader.js';
import {
  renderPullRequestContext,
} from '../../core/workflow/pr-context.js';
import type {
  RetryContext,
  RetryFailureInfo,
  RetryRunInfo,
} from './retryMode.js';
import type { InstructModeOptions } from '../tasks/list/instructMode.js';
import {
  buildOrderRevisionPrompt,
  createOrderRevisionSelector,
  normalizeOrderRevisionSummary,
} from './orderRevisionMode.js';
import { resolveMaxImageIndex } from '../tasks/orderRevision.js';
import { buildReplayHint } from './interactive-summary.js';
import { SlashCommand } from '../../shared/constants.js';

const RETRY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
const INSTRUCT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

const EMPTY_RUN_SESSION_VARS = {
  runTask: '',
  runWorkflow: '',
  runStatus: '',
  runStepLogs: '',
  runReports: '',
};

function retrySubjectLabel(kind: RetryContext['subject']['kind'], lang: 'en' | 'ja'): string {
  return kind === 'run' ? 'Run' : lang === 'ja' ? 'ブランチ' : 'Branch';
}

function retryTemplateVars(
  context: RetryContext,
  lang: 'en' | 'ja',
): Record<string, string | boolean> {
  const hasWorkflowPreview = (context.workflowContext.stepPreviews?.length ?? 0) > 0;
  const run = context.run;
  return {
    taskName: context.failure.taskName,
    taskContent: context.failure.taskContent,
    subjectLabel: retrySubjectLabel(context.subject.kind, lang),
    subjectValue: context.subject.value,
    createdAt: context.failure.createdAt,
    failedStep: context.failure.failedStep,
    failureError: context.failure.error,
    failureLastMessage: context.failure.lastMessage,
    retryNote: context.failure.retryNote,
    hasWorkflowPreview,
    workflowStructure: context.workflowContext.workflowStructure,
    stepDetails: hasWorkflowPreview
      ? formatStepPreviews(context.workflowContext.stepPreviews!, lang)
      : '',
    hasRun: run !== null,
    runLogsDir: run?.logsDir ?? '',
    runReportsDir: run?.reportsDir ?? '',
    runTask: run?.task ?? '',
    runWorkflow: run?.workflow ?? '',
    runStatus: run?.status ?? '',
    runStepLogs: run?.stepLogs ?? '',
    runReports: run?.reports ?? '',
    hasOrderContent: context.previousOrderContent !== null,
    orderContent: context.previousOrderContent ?? '',
    hasPrContext: context.prContext !== undefined,
    prContextText: context.prContext === undefined
      ? ''
      : renderPullRequestContext(context.prContext, lang),
  };
}

function instructTemplateVars(
  options: InstructModeOptions,
  lang: 'en' | 'ja',
): Record<string, string | boolean> {
  const workflowContext = options.workflowContext;
  const hasWorkflowPreview = (workflowContext?.stepPreviews?.length ?? 0) > 0;
  const hasRunSession = options.runSessionContext !== undefined;
  const runVars = hasRunSession
    ? formatRunSessionForPrompt(options.runSessionContext!)
    : EMPTY_RUN_SESSION_VARS;
  const reportSummary = options.failedContext?.reportSummary.length
    ? formatLiteralBlock(options.failedContext.reportSummary)
    : '';
  const worktreeSummary = options.failedContext?.worktreeSummary.length
    ? formatLiteralBlock(options.failedContext.worktreeSummary)
    : '';
  return {
    taskName: options.taskName,
    taskContent: options.taskContent,
    branchName: options.branchName,
    branchContext: options.branchContext.length > 0
      ? formatLiteralBlock(options.branchContext)
      : '',
    retryNote: options.retryNote,
    hasWorkflowPreview,
    workflowStructure: workflowContext?.workflowStructure ?? '',
    stepDetails: hasWorkflowPreview
      ? formatStepPreviews(workflowContext!.stepPreviews!, lang)
      : '',
    hasRunSession,
    ...runVars,
    hasOrderContent: !!options.previousOrderContent,
    orderContent: options.previousOrderContent ?? '',
    hasPrContext: options.prContext !== undefined,
    prContextText: options.prContext === undefined
      ? ''
      : renderPullRequestContext(options.prContext, lang),
    hasFailedContext: reportSummary.length > 0 || worktreeSummary.length > 0,
    hasReportSummary: reportSummary.length > 0,
    hasWorktreeSummary: worktreeSummary.length > 0,
    reportSummary,
    worktreeSummary,
  };
}

function withOrderRevision(
  strategy: ConversationStrategy,
  canonicalOrderContent: string,
  lang: 'en' | 'ja',
  retry: boolean,
  previousOrderContent?: string,
): ConversationStrategy {
  return {
    ...strategy,
    selectGoAction: createOrderRevisionSelector(),
    ...(retry
      ? { selectRetryAction: async () => 'execute' as const }
      : {}),
    summaryPromptBuilder: (summaryOptions) =>
      buildOrderRevisionPrompt(summaryOptions, canonicalOrderContent),
    normalizeSummaryTask: (task, attachments) =>
      normalizeOrderRevisionSummary(task, attachments, lang),
    initialImageAttachmentIndex: resolveMaxImageIndex(canonicalOrderContent),
    formalSpecInitialContext: canonicalOrderContent,
    enabledCommands: [
      SlashCommand.Go,
      ...(retry ? [SlashCommand.Retry] : []),
      ...(retry ? [SlashCommand.Replay] : [SlashCommand.Replay]),
      SlashCommand.Cancel,
      SlashCommand.Resume,
      SlashCommand.PasteImage,
      ...(strategy.formalSpec ? [SlashCommand.Verify] : []),
    ],
    ...(retry ? { enableRetryCommand: true } : {}),
    ...(previousOrderContent === undefined ? {} : { previousOrderContent }),
    trackResultSource: true,
  };
}

/** Construct the retry plan used by CLI adapters and Web ConversationSession. */
export function createRetryConversationPlan(
  cwd: string,
  context: RetryContext,
  options: { readonly reviseOrder?: boolean } = {},
): ConversationPlan {
  const config = resolveConfigValues(cwd, ['language']);
  const lang = resolveLanguage(config.language);
  const baseCtx = initializeSession(cwd, 'retry');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'retry' };
  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  const canonicalOrderContent = (context.previousOrderContent ?? context.failure.taskContent).trim();
  const systemPrompt = prependSourceContextGuardToSystemPrompt(
    lang,
    loadTemplate('score_retry_system_prompt', lang, retryTemplateVars(context, lang)),
  );
  const baseStrategy: ConversationStrategy = {
    systemPrompt,
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    allowedTools: RETRY_TOOLS,
    transformPrompt: (message, sourceContext) => prependSourceContext(lang, message, sourceContext),
    introMessage: lang === 'ja'
      ? `## リトライ: ${context.failure.taskName}\n\n${retrySubjectLabel(context.subject.kind, lang)}: ${context.subject.value}\n\n${getLabel('retry.ui.intro', lang)}`
      : `## Retry: ${context.failure.taskName}\n\n${retrySubjectLabel(context.subject.kind, lang)}: ${context.subject.value}\n\n${getLabel('retry.ui.intro', lang)}`,
    previousOrderContent: context.previousOrderContent ?? undefined,
    enableRetryCommand: true,
    formalSpecInitialContext: canonicalOrderContent,
  };
  return {
    ctx,
    strategy: options.reviseOrder === true
      ? withOrderRevision(baseStrategy, canonicalOrderContent, lang, true)
      : baseStrategy,
  };
}

/** Construct the instruct plan used by CLI adapters and Web ConversationSession. */
export function createInstructConversationPlan(
  cwd: string,
  options: InstructModeOptions,
): ConversationPlan {
  const config = resolveWorkflowConfigValues(cwd, ['language']);
  const lang = resolveLanguage(config.language);
  const baseCtx = initializeSession(cwd, 'instruct');
  const ctx: SessionContext = { ...baseCtx, lang, personaName: 'instruct' };
  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  const canonicalOrderContent = (options.previousOrderContent ?? options.taskContent).trim();
  const ui = getLabelObject<InstructUIText>('instruct.ui', lang);
  const strategy: ConversationStrategy = {
    systemPrompt: prependSourceContextGuardToSystemPrompt(
      lang,
      loadTemplate('score_instruct_system_prompt', lang, instructTemplateVars(options, lang)),
    ),
    formalSpec: formalSpecConfiguration.mode,
    formalSpecComments: formalSpecConfiguration.comments,
    allowedTools: INSTRUCT_TOOLS,
    transformPrompt: (message, sourceContext) => prependSourceContext(lang, message, sourceContext),
    introMessage: `${ui.intro}${buildReplayHint(lang, !!options.previousOrderContent)}`,
    previousOrderContent: options.previousOrderContent ?? undefined,
  };
  return {
    ctx,
    strategy: withOrderRevision(
      strategy,
      canonicalOrderContent,
      lang,
      false,
      options.previousOrderContent ?? undefined,
    ),
  };
}

/** Build the richer run data used by an instruct plan without changing its type. */
export function makeRunContextForInstruct(
  context: RunSessionContext | undefined,
): RunSessionContext | undefined {
  return context;
}

export type { RetryFailureInfo, RetryRunInfo };
