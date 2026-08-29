import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { promptInput, selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { info } from '../../shared/ui/index.js';
import { lstatIfExists, sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  getBuiltinWorkflowsDir,
  listWorkflowEntries,
  resolveWorkflowConfigValue,
  type WorkflowDirEntry,
  type WorkflowSource,
} from '../../infra/config/index.js';
import { createAssistantConversationPlan, type ConversationPlan } from '../interactive/conversationPlan.js';
import type { ConversationMessage } from '../interactive/interactiveApplication.js';
import {
  cleanupImageAttachmentStore,
  cleanupImageAttachmentStoreOnProcessExit,
  createSessionImageAttachmentStore,
} from '../interactive/imageAttachments.js';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import type { PostSummaryAction } from '../interactive/interactive-summary.js';
import type { TaskExecutionOptions } from '../tasks/execute/types.js';
import { runWorkflowExecution } from '../tasks/execute/workflowExecutionApi.js';
import { runTuiConversation } from '../tui/conversationRunner.js';
import {
  createTuiConversation,
  type TuiConversation,
  type TuiSubmitInput,
  type TuiSubmission,
} from '../tui/tuiConversation.js';
import { describeSessionModel } from '../tui/tuiSetup.js';
import {
  materializeWorkflowMakerArtifact,
  planWorkflowMakerArtifact,
  type WorkflowMakerArtifactPlan,
  type WorkflowMakerBase,
} from './artifact.js';

export interface RunWorkflowMakerTuiOptions {
  readonly projectDir: string;
  readonly agentOverrides?: TaskExecutionOptions;
}

type BaseSourceChoice = 'new' | WorkflowSource;
type MakerAction = 'execute' | 'continue';

const MAKER_COMMANDS = [
  SlashCommand.Go,
  SlashCommand.Cancel,
  SlashCommand.Workflow,
  SlashCommand.PasteImage,
] as const;

const SOURCE_ORDER: readonly BaseSourceChoice[] = [
  'new',
  'project',
  'user',
  'builtin',
  'repertoire',
];

function baseDisplayName(base: WorkflowMakerBase): string {
  return base.kind === 'new' ? base.name : base.workflow.name;
}

function buildSourceContext(base: WorkflowMakerBase): string {
  if (base.kind === 'new') {
    return [
      'Workflow Maker base kind: new',
      `Workflow name: ${base.name}`,
    ].join('\n');
  }
  return [
    'Workflow Maker base kind: existing',
    `Workflow source: ${base.workflow.source}`,
    `Workflow path: ${base.workflow.path}`,
    '',
    readFileSync(base.workflow.path, 'utf-8'),
  ].join('\n');
}

function buildMakerPlan(
  projectDir: string,
  base: WorkflowMakerBase,
  agentOverrides: TaskExecutionOptions | undefined,
): ConversationPlan {
  const assistantConversationInput = {
    assistantMode: 'assistant' as const,
    formalSpec: false,
    formalSpecComments: true,
    ...(agentOverrides?.provider ? { provider: agentOverrides.provider } : {}),
    ...(agentOverrides?.model ? { model: agentOverrides.model } : {}),
  };
  const plan = createAssistantConversationPlan(projectDir, assistantConversationInput);
  const makerPrompt = loadTemplate('workflow_maker_assistant', plan.ctx.lang).trim();
  return {
    ctx: plan.ctx,
    strategy: {
      ...plan.strategy,
      systemPrompt: `${plan.strategy.systemPrompt}\n\n${makerPrompt}`,
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      permissionMode: 'readonly',
      introMessage: getLabel('workflowMaker.intro', plan.ctx.lang),
      summaryPromptContext: [plan.strategy.summaryPromptContext, makerPrompt]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join('\n\n'),
      enabledCommands: MAKER_COMMANDS,
    },
  };
}

function sourceOptions(lang: 'en' | 'ja'): SelectOptionItem<BaseSourceChoice>[] {
  return SOURCE_ORDER.map((source) => ({
    value: source,
    label: getLabel(`workflowMaker.sources.${source}`, lang),
  }));
}

async function selectWorkflowMakerBase(
  projectDir: string,
  lang: 'en' | 'ja',
): Promise<WorkflowMakerBase | null> {
  while (true) {
    const source = await selectOption(
      getLabel('workflowMaker.basePrompt', lang),
      sourceOptions(lang),
    );
    if (source === null) return null;
    if (source === 'new') {
      const name = await promptInput(getLabel('workflowMaker.namePrompt', lang));
      if (name === null) return null;
      return { kind: 'new', name };
    }

    const entries = listWorkflowEntries(projectDir).filter((entry) => entry.source === source);
    if (entries.length === 0) {
      info(getLabel('workflowMaker.noWorkflows', lang));
      continue;
    }
    const byValue = new Map<string, WorkflowDirEntry>();
    const options = entries.map((entry, index) => {
      const value = String(index);
      byValue.set(value, entry);
      return {
        value,
        label: sanitizeTerminalText(entry.name),
        description: sanitizeTerminalText(basename(entry.path)),
      };
    });
    const selected = await selectOption(getLabel('workflowMaker.workflowPrompt', lang), options);
    if (selected === null) continue;
    const entry = byValue.get(selected);
    if (entry === undefined) {
      throw new Error(`Workflow Maker selection disappeared: ${selected}`);
    }
    return {
      kind: 'existing',
      workflow: {
        name: entry.name,
        path: entry.path,
        source: entry.source,
      },
    };
  }
}

function createConversationFacade(current: () => TuiConversation): TuiConversation {
  return {
    get lang() {
      return current().lang;
    },
    get commandAvailability() {
      return current().commandAvailability;
    },
    get tracksResultSource() {
      return current().tracksResultSource;
    },
    isCommandLine(text: string): boolean {
      return current().isCommandLine(text);
    },
    resolveLocalCommand(text: string) {
      return current().resolveLocalCommand(text);
    },
    submit(input: TuiSubmitInput): Promise<TuiSubmission> {
      return current().submit(input);
    },
    createInstruction(input: TuiSubmitInput): Promise<TuiSubmission> {
      return current().createInstruction(input);
    },
    resumeSession(sessionId: string): Promise<string | undefined> {
      return current().resumeSession(sessionId);
    },
    recordRejectedDraft(task: string): void {
      current().recordRejectedDraft?.(task);
    },
    snapshotHistory(): readonly ConversationMessage[] {
      return current().snapshotHistory?.() ?? [];
    },
    setEffort(effort: string): void {
      current().setEffort?.(effort);
    },
    pasteClipboardImage(abortSignal: AbortSignal): Promise<string> {
      return current().pasteClipboardImage(abortSignal);
    },
    sealImages(): void {
      current().sealImages();
    },
    saveInlineImage(image) {
      return current().saveInlineImage(image);
    },
  };
}

function doctorReportPath(reportDirectory?: string): string | undefined {
  if (reportDirectory === undefined) return undefined;
  const reportPath = join(reportDirectory, 'workflow-maker-doctor.md');
  const stats = lstatIfExists(reportPath);
  return stats !== null && stats.isFile() && !stats.isSymbolicLink() ? reportPath : undefined;
}

export async function runWorkflowMakerTui(options: RunWorkflowMakerTuiOptions): Promise<void> {
  const lang = resolveWorkflowConfigValue(options.projectDir, 'language');
  let selectedBase = await selectWorkflowMakerBase(options.projectDir, lang);
  if (selectedBase === null) return;

  const attachmentStore = createSessionImageAttachmentStore(options.projectDir);
  const releaseExitCleanup = cleanupImageAttachmentStoreOnProcessExit(attachmentStore);
  let pendingPlan: WorkflowMakerArtifactPlan | undefined;

  const createConversation = (history?: readonly ConversationMessage[]) => {
    const plan = buildMakerPlan(options.projectDir, selectedBase!, options.agentOverrides);
    const conversation = createTuiConversation({
      cwd: options.projectDir,
      plan,
      sourceContext: buildSourceContext(selectedBase!),
      attachmentStore,
      enableSettingsCommands: true,
      persistSession: false,
      ...(history === undefined || history.length === 0 ? {} : { handoffHistory: history }),
    });
    return { plan, conversation };
  };
  let { plan: currentPlan, conversation: currentConversation } = createConversation();

  const rebuildConversation = (history?: readonly ConversationMessage[]): void => {
    const next = createConversation(history);
    currentPlan = next.plan;
    currentConversation = next.conversation;
  };

  try {
    const facade = createConversationFacade(() => currentConversation);
    await runTuiConversation({
      cwd: options.projectDir,
      lang,
      conversation: facade,
      initialEntries: [{ role: 'system', content: currentPlan.strategy.introMessage }],
      submitMode: 'chat',
      autoSubmit: false,
      modelLabel: () => getLabel('tui.ui.model', lang, { value: describeSessionModel(currentPlan.ctx) }),
      continuePrompt: getLabel('workflowMaker.continuePrompt', lang),
      dispatchPlaceholder: getLabel('workflowMaker.wait', lang),
      chooseAction: async (task): Promise<{ action: PostSummaryAction; task: string } | null> => {
        try {
          pendingPlan = await planWorkflowMakerArtifact({
            projectDir: options.projectDir,
            base: selectedBase!,
          });
        } catch (error) {
          const reason = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
          info(getLabel('workflowMaker.planningFailed', lang, { reason }));
          return null;
        }
        info(getLabel('workflowMaker.proposed', lang));
        info(sanitizeTerminalText(task));
        info(getLabel('workflowMaker.plannedPath', lang, {
          path: sanitizeTerminalText(pendingPlan.artifactRoot),
        }));
        const action = await selectOption<MakerAction>(getLabel('workflowMaker.actionPrompt', lang), [
          { value: 'execute', label: getLabel('workflowMaker.actions.execute', lang) },
          { value: 'continue', label: getLabel('workflowMaker.actions.continue', lang) },
        ], {
          cancelLabel: getLabel('exec.common.cancel', lang),
        });
        if (action === null) {
          pendingPlan = undefined;
          return null;
        }
        return { action, task };
      },
      dispatch: async (result: InteractiveModeResult): Promise<string> => {
        const plan = pendingPlan;
        pendingPlan = undefined;
        if (plan === undefined) {
          throw new Error('Workflow Maker execution was approved without an artifact plan');
        }
        try {
          await materializeWorkflowMakerArtifact(plan);
          const execution = await runWorkflowExecution({
            task: result.task,
            cwd: plan.artifactRoot,
            projectCwd: options.projectDir,
            workflowIdentifier: join(getBuiltinWorkflowsDir(lang), 'workflow-maker.yaml'),
            agentOverrides: options.agentOverrides,
            outputMode: 'terminal',
            interactiveUserInput: false,
            interactiveMetadata: { confirmed: true, task: result.task },
          });
          const report = doctorReportPath(execution.reportDirectory);
          if (!execution.success) {
            return getLabel(report === undefined ? 'workflowMaker.failedWithoutReport' : 'workflowMaker.failed', lang, {
              path: plan.artifactRoot,
              reason: sanitizeTerminalText(execution.reason ?? execution.lastMessage ?? 'unknown'),
              ...(report === undefined ? {} : { report }),
            });
          }
          return getLabel(
            report === undefined ? 'workflowMaker.completedWithoutReport' : 'workflowMaker.completed',
            lang,
            { path: plan.artifactRoot, ...(report === undefined ? {} : { report }) },
          );
        } catch (error) {
          return getLabel('workflowMaker.failedWithoutReport', lang, {
            path: plan.artifactRoot,
            reason: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
          });
        }
      },
      onHandoff: async (id) => {
        if (id !== 'workflow') {
          throw new Error(`Unsupported Workflow Maker hand-off: ${id}`);
        }
        const history = currentConversation.snapshotHistory?.() ?? [];
        const nextBase = await selectWorkflowMakerBase(options.projectDir, lang);
        if (nextBase === null) return { kind: 'continue' as const };
        selectedBase = nextBase;
        pendingPlan = undefined;
        rebuildConversation(history);
        return {
          kind: 'continue' as const,
          notice: getLabel('workflowMaker.baseChanged', lang, {
            name: sanitizeTerminalText(baseDisplayName(selectedBase)),
          }),
        };
      },
    });
  } finally {
    cleanupImageAttachmentStore(attachmentStore);
    releaseExitCleanup();
  }
}
