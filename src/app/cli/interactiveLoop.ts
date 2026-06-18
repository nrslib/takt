import { checkoutBranch } from '../../infra/task/index.js';
import {
  getWorkflowDescription,
  loadPersonaSessions,
  resolveConfigValues,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { resolveAssistantProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import { INTERACTIVE_MODES, type InteractiveMode } from '../../core/models/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { error as logError, info, success } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { resolveAssistantConfigLayers } from '../../features/interactive/assistantConfig.js';
import {
  createIssueAndSaveTask,
  determineWorkflow,
  promptLabelSelection,
  saveTaskFromInteractive,
  selectAndExecuteTask,
  type SelectAndExecuteTaskResult,
  type SelectAndExecuteOptions,
  type TaskExecutionOptions,
} from '../../features/tasks/index.js';
import {
  dispatchConversationAction,
  interactiveMode,
  passthroughMode,
  personaMode,
  promptContinueAfterTaskResult,
  quietMode,
  resolveLanguage,
  selectInteractiveMode,
  shouldPromptForInteractiveContinue,
  type InteractiveModeAction,
  type InteractiveModeResult,
} from '../../features/interactive/index.js';
import { loadTaskHistory } from './taskHistory.js';

interface RunInteractiveLoopOptions {
  cwd: string;
  selectOptions: SelectAndExecuteOptions;
  directTask?: string;
  sourceContext?: string;
  prBranch?: string;
  prBaseBranch?: string;
  prNumber?: number;
  sourceIssueNumber?: number;
  continuePreviousSession: boolean;
  agentOverrides?: TaskExecutionOptions;
}

type ConversationDispatchResult =
  | { action: 'executed'; result: SelectAndExecuteTaskResult }
  | { action: 'done' };

export async function runInteractiveLoop(options: RunInteractiveLoopOptions): Promise<void> {
  const globalConfig = resolveConfigValues(
    options.cwd,
    ['language', 'interactivePreviewSteps'],
  );
  const lang = resolveLanguage(globalConfig.language);
  let firstIteration = true;

  while (true) {
    const currentDirectTask = firstIteration ? options.directTask : undefined;
    const currentSourceContext = firstIteration ? options.sourceContext : undefined;
    const currentPrBranch = firstIteration ? options.prBranch : undefined;
    const currentPrBaseBranch = firstIteration ? options.prBaseBranch : undefined;
    const currentPrNumber = firstIteration ? options.prNumber : undefined;
    const currentSourceIssueNumber = firstIteration ? options.sourceIssueNumber : undefined;

    const workflowId = await determineWorkflow(options.cwd, options.selectOptions.workflow);
    if (workflowId === null) {
      info(getLabel('interactive.ui.cancelled', lang));
      return;
    }

    const workflowDesc = getWorkflowDescription(workflowId, options.cwd, globalConfig.interactivePreviewSteps);
    const availableInteractiveModes = currentSourceContext && !currentDirectTask
      ? INTERACTIVE_MODES.filter((mode) => mode !== 'passthrough')
      : INTERACTIVE_MODES;
    const selectedMode = await selectInteractiveMode(
      lang,
      workflowDesc.interactiveMode,
      availableInteractiveModes,
    );
    if (selectedMode === null) {
      info(getLabel('interactive.ui.cancelled', lang));
      return;
    }

    const workflowContext = {
      name: workflowDesc.name,
      description: workflowDesc.description,
      workflowStructure: workflowDesc.workflowStructure,
      stepPreviews: workflowDesc.stepPreviews,
      taskHistory: loadTaskHistory(options.cwd, lang),
    };
    const interactiveSeed = currentDirectTask || currentSourceContext
      ? {
        ...(currentDirectTask ? { userMessage: currentDirectTask } : {}),
        ...(currentSourceContext ? { sourceContext: currentSourceContext } : {}),
      }
      : undefined;

    const result = await runSelectedInteractiveMode({
      cwd: options.cwd,
      selectedMode,
      workflowDesc,
      workflowContext,
      interactiveSeed,
      directTask: currentDirectTask,
      prBranch: currentPrBranch,
      continuePreviousSession: firstIteration && options.continuePreviousSession,
      agentOverrides: options.agentOverrides,
      lang,
    });

    const dispatchResult = await dispatchConversationAction<InteractiveModeAction, ConversationDispatchResult>(result, {
      execute: async ({ task: confirmedTask }) => {
        const baseExecutionOptions = createExecutionOptionsBase(
          options.selectOptions,
          firstIteration,
        );
        const executionOptions: SelectAndExecuteOptions = {
          ...baseExecutionOptions,
          interactiveUserInput: true,
          workflow: workflowId,
          interactiveMetadata: { confirmed: true, task: confirmedTask },
          skipTaskList: true,
          exitOnFailure: false,
          ...(result.attachments ? { attachments: result.attachments } : {}),
        };

        if (currentPrBranch) {
          info(`Fetching and checking out PR branch: ${currentPrBranch}`);
          checkoutBranch(options.cwd, currentPrBranch);
          success(`Checked out PR branch: ${currentPrBranch}`);
        }

        try {
          const taskResult = await selectAndExecuteTask(
            options.cwd,
            confirmedTask,
            executionOptions,
            options.agentOverrides,
          );
          return { action: 'executed', result: taskResult } as const;
        } catch (error) {
          logError(getErrorMessage(error));
          return { action: 'executed', result: { success: false, status: 'failed' } } as const;
        }
      },
      create_issue: async ({ task: confirmedTask }) => {
        const labels = await promptLabelSelection(lang);
        await createIssueAndSaveTask(options.cwd, confirmedTask, workflowId, {
          confirmAtEndMessage: 'Add this issue to tasks?',
          labels,
          ...(result.attachments ? { attachments: result.attachments } : {}),
        });
        return { action: 'done' } as const;
      },
      save_task: async ({ task: confirmedTask }) => {
        const presetSettings = currentPrBranch
          ? {
            worktree: true as const,
            branch: currentPrBranch,
            autoPr: true,
            ...(currentPrBaseBranch ? { baseBranch: currentPrBaseBranch } : {}),
          }
          : undefined;
        await saveTaskFromInteractive(options.cwd, confirmedTask, workflowId, {
          presetSettings,
          ...(currentPrNumber !== undefined ? { prNumber: currentPrNumber } : {}),
          ...(currentSourceIssueNumber !== undefined ? { issue: currentSourceIssueNumber } : {}),
          ...(result.attachments ? { attachments: result.attachments } : {}),
        });
        return { action: 'done' } as const;
      },
      cancel: () => ({ action: 'done' }) as const,
    }) as ConversationDispatchResult;

    if (dispatchResult.action !== 'executed') {
      return;
    }
    if (dispatchResult.result.status === 'interrupted') {
      process.exit(1);
    }
    if (!shouldPromptForInteractiveContinue({ selectedMode })) {
      if (!dispatchResult.result.success) {
        process.exit(1);
      }
      return;
    }

    const shouldContinue = await promptContinueAfterTaskResult(dispatchResult.result.success, lang);
    if (!shouldContinue) {
      if (!dispatchResult.result.success) {
        process.exit(1);
      }
      return;
    }

    firstIteration = false;
  }
}

function createExecutionOptionsBase(
  selectOptions: SelectAndExecuteOptions,
  includeTraceTaskContext: boolean,
): SelectAndExecuteOptions {
  if (includeTraceTaskContext) {
    return selectOptions;
  }

  return {
    ...(selectOptions.workflow !== undefined ? { workflow: selectOptions.workflow } : {}),
    ...(selectOptions.interactiveUserInput !== undefined ? { interactiveUserInput: selectOptions.interactiveUserInput } : {}),
    ...(selectOptions.interactiveMetadata !== undefined ? { interactiveMetadata: selectOptions.interactiveMetadata } : {}),
    ...(selectOptions.skipTaskList !== undefined ? { skipTaskList: selectOptions.skipTaskList } : {}),
    ...(selectOptions.exitOnFailure !== undefined ? { exitOnFailure: selectOptions.exitOnFailure } : {}),
    ...(selectOptions.attachments !== undefined ? { attachments: selectOptions.attachments } : {}),
  };
}

interface RunSelectedInteractiveModeOptions {
  cwd: string;
  selectedMode: InteractiveMode;
  workflowDesc: ReturnType<typeof getWorkflowDescription>;
  workflowContext: Parameters<typeof interactiveMode>[2];
  interactiveSeed: Parameters<typeof interactiveMode>[1];
  directTask?: string;
  prBranch?: string;
  continuePreviousSession: boolean;
  agentOverrides?: TaskExecutionOptions;
  lang: ReturnType<typeof resolveLanguage>;
}

async function runSelectedInteractiveMode(options: RunSelectedInteractiveModeOptions): Promise<InteractiveModeResult> {
  switch (options.selectedMode) {
    case 'assistant':
      return runAssistantMode(options);

    case 'passthrough':
      return passthroughMode(options.lang, options.directTask);

    case 'quiet':
      return quietMode(options.cwd, options.interactiveSeed, options.workflowContext);

    case 'persona':
      if (!options.workflowDesc.firstStep) {
        info(getLabel('interactive.ui.personaFallback', options.lang));
        return interactiveMode(options.cwd, options.interactiveSeed, options.workflowContext);
      }
      return personaMode(options.cwd, options.workflowDesc.firstStep, options.interactiveSeed, options.workflowContext);
  }
}

async function runAssistantMode(options: RunSelectedInteractiveModeOptions): Promise<InteractiveModeResult> {
  let selectedSessionId: string | undefined;
  if (options.continuePreviousSession) {
    const { provider: providerType } = resolveAssistantProviderModelFromConfig(
      resolveAssistantConfigLayers(options.cwd),
      {
        provider: options.agentOverrides?.provider,
        model: options.agentOverrides?.model,
      },
    );
    if (!providerType) {
      throw new Error('Provider is not configured.');
    }
    const savedSessions = loadPersonaSessions(options.cwd, providerType);
    const savedSessionId = resolvePersonaSessionId(savedSessions, 'interactive', providerType);
    if (savedSessionId) {
      selectedSessionId = savedSessionId;
    } else {
      info(getLabel('interactive.continueNoSession', options.lang));
    }
  }

  const interactiveOpts = options.prBranch ? { excludeActions: ['create_issue'] as const } : undefined;
  const assistantModeOptions = {
    ...interactiveOpts,
    ...(options.agentOverrides?.provider ? { provider: options.agentOverrides.provider } : {}),
    ...(options.agentOverrides?.model ? { model: options.agentOverrides.model } : {}),
  };

  return interactiveMode(
    options.cwd,
    options.interactiveSeed,
    options.workflowContext,
    selectedSessionId,
    undefined,
    Object.keys(assistantModeOptions).length > 0 ? assistantModeOptions : undefined,
  );
}
