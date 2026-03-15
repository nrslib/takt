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
import { getPieceDescription, resolveConfigValue, resolveConfigValues, loadPersonaSessions } from '../../infra/config/index.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides } from './helpers.js';
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
  const resolvedPipelinePiece = opts.piece as string | undefined;
  if (pipelineMode && resolvedPipelinePiece === undefined) {
    logError('--piece (-w) is required in pipeline mode');
    process.exit(1);
  }
  const resolvedPipelineAutoPr = opts.autoPr === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'autoPr') ?? false);
  const resolvedPipelineDraftPr = opts.draft === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'draftPr') ?? false);
  const selectOptions: SelectAndExecuteOptions = {
    piece: opts.piece as string | undefined,
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

  const globalConfig = resolveConfigValues(resolvedCwd, ['language', 'interactivePreviewMovements', 'provider']);
  const lang = resolveLanguage(globalConfig.language);

  const pieceId = await determinePiece(resolvedCwd, selectOptions.piece);
  if (pieceId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const previewCount = globalConfig.interactivePreviewMovements;
  const pieceDesc = getPieceDescription(pieceId, resolvedCwd, previewCount);

  const selectedMode = await selectInteractiveMode(lang, pieceDesc.interactiveMode);
  if (selectedMode === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const pieceContext = {
    name: pieceDesc.name,
    description: pieceDesc.description,
    pieceStructure: pieceDesc.pieceStructure,
    movementPreviews: pieceDesc.movementPreviews,
    taskHistory: loadTaskHistory(resolvedCwd, lang),
  };

  let result: InteractiveModeResult;

  switch (selectedMode) {
    case 'assistant': {
      let selectedSessionId: string | undefined;
      if (opts.continue === true) {
        const providerType = globalConfig.provider;
        const savedSessions = loadPersonaSessions(resolvedCwd, providerType);
        const savedSessionId = savedSessions['interactive'];
        if (savedSessionId) {
          selectedSessionId = savedSessionId;
        } else {
          info(getLabel('interactive.continueNoSession', lang));
        }
      }
      const interactiveOpts = prBranch ? { excludeActions: ['create_issue'] as const } : undefined;
      result = await interactiveMode(resolvedCwd, initialInput, pieceContext, selectedSessionId, undefined, interactiveOpts);
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
  }

  await dispatchConversationAction(result, {
    execute: async ({ task: confirmedTask }) => {
      if (prBranch) {
        info(`Fetching and checking out PR branch: ${prBranch}`);
        checkoutBranch(resolvedCwd, prBranch);
        success(`Checked out PR branch: ${prBranch}`);
      }
      selectOptions.interactiveUserInput = true;
      selectOptions.piece = pieceId;
      selectOptions.interactiveMetadata = { confirmed: true, task: confirmedTask };
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
