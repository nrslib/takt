import { info, success, error as logError } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { checkoutBranch } from '../../infra/task/index.js';
import { selectAndExecuteTask, determinePiece, saveTaskFromInteractive, createIssueAndSaveTask, promptLabelSelection, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import {
  interactiveMode,
  selectInteractiveMode,
  passthroughMode,
  quietMode,
  personaMode,
  resolveLanguage,
  dispatchConversationAction,
  type InteractiveModeResult,
} from '../../features/interactive/index.js';
import {
  getPieceDescription,
  resolveConfigValue,
  resolveConfigValues,
  loadPersonaSessions,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { resolveAssistantProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import { DEFAULT_INTERACTIVE_MODE, type InteractiveMode } from '../../core/models/index.js';
import { resolveAssistantConfigLayers } from '../../features/interactive/assistantConfig.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { loadTaskHistory } from './taskHistory.js';
import { resolveIssueInput, resolvePrInput } from './routing-inputs.js';

export async function executeDefaultAction(task?: string): Promise<void> {
  const opts = program.opts();
  if (!pipelineMode && (opts.autoPr === true || opts.draft === true)) {
    logError('--auto-pr/--draft are supported only in --pipeline mode');
    process.exit(1);
  }
  const prNumber = opts.pr as number | undefined;
  const issueNumber = opts.issue as number | undefined;

  if (prNumber && issueNumber) {
    logError('--pr and --issue cannot be used together');
    process.exit(1);
  }

  if (prNumber && (opts.task as string | undefined)) {
    logError('--pr and --task cannot be used together');
    process.exit(1);
  }
  const agentOverrides = resolveAgentOverrides(program);
  let resolvedWorkflow: string | undefined;
  try {
    resolvedWorkflow = resolveWorkflowCliOption(opts as Record<string, unknown>);
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const resolvedPipelinePiece = resolvedWorkflow;
  if (pipelineMode && resolvedPipelinePiece === undefined) {
    logError('--workflow (-w, alias: --piece) is required in pipeline mode');
    process.exit(1);
  }
  const resolvedPipelineAutoPr = opts.autoPr === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'autoPr') ?? false);
  const resolvedPipelineDraftPr = opts.draft === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'draftPr') ?? false);
  const selectOptions: SelectAndExecuteOptions = {
    piece: resolvedWorkflow,
  };

  if (pipelineMode) {
    const exitCode = await executePipeline({
      issueNumber,
      prNumber,
      task: opts.task as string | undefined,
      piece: resolvedPipelinePiece!,
      branch: opts.branch as string | undefined,
      autoPr: resolvedPipelineAutoPr,
      draftPr: resolvedPipelineDraftPr,
      repo: opts.repo as string | undefined,
      skipGit: opts.skipGit === true,
      cwd: resolvedCwd,
      provider: agentOverrides?.provider,
      model: agentOverrides?.model,
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const taskFromOption = opts.task as string | undefined;
  if (taskFromOption) {
    selectOptions.skipTaskList = true;
    await selectAndExecuteTask(resolvedCwd, taskFromOption, selectOptions, agentOverrides);
    return;
  }

  let initialInput: string | undefined = task;
  let prBranch: string | undefined;
  let prBaseBranch: string | undefined;

  if (prNumber) {
    try {
      const prResult = await resolvePrInput(prNumber);
      initialInput = prResult.initialInput;
      prBranch = prResult.prBranch;
      prBaseBranch = prResult.baseBranch;
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  } else {
    try {
      const issueResult = await resolveIssueInput(issueNumber, task);
      if (issueResult) {
        initialInput = issueResult.initialInput;
      }
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  }

  const globalConfig = resolveConfigValues(
    resolvedCwd,
    ['language', 'interactivePreviewMovements'],
  );
  const lang = resolveLanguage(globalConfig.language);

  const pieceId = await determinePiece(resolvedCwd, selectOptions.piece);
  if (pieceId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const previewCount = globalConfig.interactivePreviewMovements;
  const pieceDesc = getPieceDescription(pieceId, resolvedCwd, previewCount);

  let selectedMode: InteractiveMode;
  if (pieceDesc.skipInteractiveModeSelection === true) {
    selectedMode = pieceDesc.interactiveMode ?? DEFAULT_INTERACTIVE_MODE;
  } else {
    const mode = await selectInteractiveMode(lang, pieceDesc.interactiveMode);
    if (mode === null) {
      info(getLabel('interactive.ui.cancelled', lang));
      return;
    }
    selectedMode = mode;
  }

  const pieceContext = {
    name: pieceDesc.name,
    description: pieceDesc.description,
    pieceStructure: pieceDesc.pieceStructure,
    movementPreviews: pieceDesc.movementPreviews,
    taskHistory: loadTaskHistory(resolvedCwd, lang),
  };

  let result: InteractiveModeResult;

  if (selectedMode === 'none') {
    const trimmedInput = (initialInput?.trim() ?? '');
    result = { action: 'execute', task: trimmedInput === '' ? pieceDesc.name : trimmedInput };
  } else {
    switch (selectedMode) {
      case 'assistant': {
        let selectedSessionId: string | undefined;
        if (opts.continue === true) {
          const { provider: providerType } = resolveAssistantProviderModelFromConfig(
            resolveAssistantConfigLayers(resolvedCwd),
            {
              provider: agentOverrides?.provider,
              model: agentOverrides?.model,
            },
          );
          if (!providerType) {
            throw new Error('Provider is not configured.');
          }
          const savedSessions = loadPersonaSessions(resolvedCwd, providerType);
          const savedSessionId = resolvePersonaSessionId(savedSessions, 'interactive', providerType);
          if (savedSessionId) {
            selectedSessionId = savedSessionId;
          } else {
            info(getLabel('interactive.continueNoSession', lang));
          }
        }
        const interactiveOpts = prBranch ? { excludeActions: ['create_issue'] as const } : undefined;
        const assistantModeOptions = {
          ...interactiveOpts,
          ...(agentOverrides?.provider ? { provider: agentOverrides.provider } : {}),
          ...(agentOverrides?.model ? { model: agentOverrides.model } : {}),
        };
        result = await interactiveMode(
          resolvedCwd,
          initialInput,
          pieceContext,
          selectedSessionId,
          undefined,
          Object.keys(assistantModeOptions).length > 0 ? assistantModeOptions : undefined,
        );
        break;
      }

      case 'passthrough':
        result = await passthroughMode(lang, initialInput);
        break;

      case 'quiet':
        result = await quietMode(resolvedCwd, initialInput, pieceContext);
        break;

      case 'persona': {
        if (!pieceDesc.firstMovement) {
          info(getLabel('interactive.ui.personaFallback', lang));
          result = await interactiveMode(resolvedCwd, initialInput, pieceContext);
        } else {
          result = await personaMode(resolvedCwd, pieceDesc.firstMovement, initialInput, pieceContext);
        }
        break;
      }

      default: {
        const _exhaustive: never = selectedMode;
        throw new Error(`Unknown interactive mode: ${_exhaustive}`);
      }
    }
  }

  await dispatchConversationAction(result, {
    execute: async ({ task: confirmedTask }) => {
      if (prBranch) {
        info(`Fetching and checking out PR branch: ${prBranch}`);
        checkoutBranch(resolvedCwd, prBranch);
        success(`Checked out PR branch: ${prBranch}`);
      }
      selectOptions.interactiveUserInput = selectedMode !== 'none';
      selectOptions.pieceUserInputHandler = true;
      selectOptions.piece = pieceId;
      selectOptions.interactiveMetadata = { confirmed: selectedMode !== 'none', task: confirmedTask };
      selectOptions.skipTaskList = true;
      await selectAndExecuteTask(resolvedCwd, confirmedTask, selectOptions, agentOverrides);
    },
    create_issue: async ({ task: confirmedTask }) => {
      const labels = await promptLabelSelection(lang);
      await createIssueAndSaveTask(resolvedCwd, confirmedTask, pieceId, {
        confirmAtEndMessage: 'Add this issue to tasks?',
        labels,
      });
    },
    save_task: async ({ task: confirmedTask }) => {
      const presetSettings = prBranch
        ? {
          worktree: true as const,
          branch: prBranch,
          autoPr: true,
          ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        }
        : undefined;
      await saveTaskFromInteractive(resolvedCwd, confirmedTask, pieceId, { presetSettings });
    },
    cancel: () => undefined,
  });
}

program
  .argument('[task]', 'Task to execute (or issue reference like "#6")')
  .action(executeDefaultAction);
