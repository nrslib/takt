import { info, success, error as logError } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import {
  checkoutBranch,
  materializePullRequestBase,
  resolveBaseBranch,
} from '../../infra/task/index.js';
import { selectAndExecuteTask, determineWorkflow, saveTaskFromInteractive, createIssueAndSaveTask, promptLabelSelection, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
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
import { cleanupInteractiveResultAttachments } from '../../features/interactive/imageAttachments.js';
import { INTERACTIVE_MODES } from '../../core/models/index.js';
import {
  getWorkflowDescription,
  resolveConfigValue,
  resolveConfigValues,
  loadPersonaSessions,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { resolveAssistantProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import { resolveAssistantConfigLayers } from '../../features/interactive/assistantConfig.js';
import { program } from './program.js';
import { getCliExecutionContext } from './initialization.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { loadTaskHistory } from './taskHistory.js';
import { resolveIssueInput, resolvePrInput } from './routing-inputs.js';
import { createPullRequestContext } from '../../core/workflow/pr-context.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';

export async function executeDefaultAction(task?: string): Promise<void> {
  const { cwd: resolvedCwd, pipelineMode } = getCliExecutionContext();
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
  const resolvedPipelineWorkflow = resolvedWorkflow;
  if (pipelineMode && resolvedPipelineWorkflow === undefined) {
    logError('--workflow (-w) is required in pipeline mode');
    process.exit(1);
  }
  const resolvedPipelineAutoPr = opts.autoPr === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'autoPr') ?? false);
  const resolvedPipelineDraftPr = opts.draft === true
    ? true
    : (resolveConfigValue(resolvedCwd, 'draftPr') ?? false);
  const selectOptions: SelectAndExecuteOptions = {
    workflow: resolvedWorkflow,
  };

  if (pipelineMode) {
    const exitCode = await executePipeline({
      issueNumber,
      prNumber,
      task: opts.task as string | undefined,
      workflow: resolvedPipelineWorkflow!,
      branch: opts.branch as string | undefined,
      autoPr: resolvedPipelineAutoPr,
      draftPr: resolvedPipelineDraftPr,
      repo: opts.repo as string | undefined,
      skipGit: opts.skipGit === true,
      cwd: resolvedCwd,
      provider: agentOverrides?.provider,
      model: agentOverrides?.model,
      autoStrategy: agentOverrides?.autoStrategy,
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

  let directTask: string | undefined = task;
  let sourceContext: string | undefined;
  let prBranch: string | undefined;
  let prBaseBranch: string | undefined;
  let sourceIssueNumber: number | undefined;

  if (prNumber) {
    try {
      const prResult = await resolvePrInput(prNumber);
      directTask = undefined;
      sourceContext = prResult.initialInput;
      prBranch = prResult.prBranch;
      prBaseBranch = prResult.baseBranch;
      const resolvedPrBase = prBaseBranch ?? resolveBaseBranch(resolvedCwd).branch;
      selectOptions.traceTaskContext = {
        source: 'pr_review',
        prNumber,
        branch: prBranch,
        baseBranch: resolvedPrBase,
      };
      selectOptions.prContext = createPullRequestContext({
        source: 'pr_review',
        prNumber,
        baseBranch: resolvedPrBase,
        headBranch: prBranch,
        baseBranchSource: prBaseBranch === undefined ? 'default_branch_fallback' : 'pull_request',
      });
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  } else {
    try {
      const issueResult = await resolveIssueInput(issueNumber, task);
      if (issueResult) {
        directTask = undefined;
        sourceContext = issueResult.initialInput;
        sourceIssueNumber = issueResult.issueNumber;
        selectOptions.traceTaskContext = {
          source: 'issue',
          ...(sourceIssueNumber !== undefined ? { issueNumber: sourceIssueNumber } : {}),
        };
      }
    } catch (e) {
      logError(getErrorMessage(e));
      process.exit(1);
    }
  }

  const globalConfig = resolveConfigValues(
    resolvedCwd,
    ['language', 'interactivePreviewSteps'],
  );
  const lang = resolveLanguage(globalConfig.language);

  const workflowId = await determineWorkflow(resolvedCwd, selectOptions.workflow);
  if (workflowId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const previewCount = globalConfig.interactivePreviewSteps;
  const workflowDesc = getWorkflowDescription(workflowId, resolvedCwd, previewCount);

  const availableInteractiveModes = sourceContext && !directTask
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
    taskHistory: loadTaskHistory(resolvedCwd, lang),
  };
  const interactiveSeed = directTask || sourceContext
    ? {
      ...(directTask ? { userMessage: directTask } : {}),
      ...(sourceContext ? { sourceContext } : {}),
    }
    : undefined;
  let result: InteractiveModeResult;
  const assistantOverrideProvider = agentOverrides?.provider;

  switch (selectedMode) {
    case 'assistant': {
      let selectedSessionId: string | undefined;
      if (opts.continue === true) {
        const { provider } = resolveAssistantProviderModelFromConfig(
          resolveAssistantConfigLayers(resolvedCwd),
          {
            provider: assistantOverrideProvider,
            model: agentOverrides?.model,
          },
        );
        if (!provider) {
          throw new Error('Provider is not configured.');
        }
        const savedSessions = loadPersonaSessions(resolvedCwd, provider);
        const savedSessionId = resolvePersonaSessionId(savedSessions, 'interactive', provider);
        if (savedSessionId) {
          selectedSessionId = savedSessionId;
        } else {
          info(getLabel('interactive.continueNoSession', lang));
        }
      }
      const interactiveOpts = prBranch ? { excludeActions: ['create_issue'] as const } : undefined;
      const assistantModeOptions = {
        ...interactiveOpts,
        ...(assistantOverrideProvider ? { provider: assistantOverrideProvider } : {}),
        ...(agentOverrides?.model ? { model: agentOverrides.model } : {}),
      };
      result = await interactiveMode(
        resolvedCwd,
        interactiveSeed,
        workflowContext,
        selectedSessionId,
        undefined,
        Object.keys(assistantModeOptions).length > 0 ? assistantModeOptions : undefined,
      );
      break;
    }

    case 'passthrough':
      result = await passthroughMode(lang, directTask);
      break;

    case 'quiet':
      result = await quietMode(resolvedCwd, interactiveSeed, workflowContext);
      break;

    case 'persona': {
      if (!workflowDesc.firstStep) {
        info(getLabel('interactive.ui.personaFallback', lang));
        result = await interactiveMode(resolvedCwd, interactiveSeed, workflowContext);
      } else {
        result = await personaMode(resolvedCwd, workflowDesc.firstStep, interactiveSeed, workflowContext);
      }
      break;
    }
  }

  try {
    await dispatchConversationAction(result, {
      execute: async ({ task: confirmedTask }) => {
        if (prBranch) {
          info(`Fetching and checking out PR branch: ${prBranch}`);
          checkoutBranch(resolvedCwd, prBranch);
          if (selectOptions.prContext) {
            selectOptions.prContext = createPullRequestContext({
              ...selectOptions.prContext,
              baseDiffRef: materializePullRequestBase(
                resolvedCwd,
                resolvedCwd,
                selectOptions.prContext.baseBranch,
              ),
              headDiffRef: toLocalBranchRef(prBranch),
            });
          }
          success(`Checked out PR branch: ${prBranch}`);
        }
        selectOptions.interactiveUserInput = true;
        selectOptions.workflow = workflowId;
        selectOptions.interactiveMetadata = { confirmed: true, task: confirmedTask };
        selectOptions.skipTaskList = true;
        if (result.attachments) {
          selectOptions.attachments = result.attachments;
        }
        await selectAndExecuteTask(resolvedCwd, confirmedTask, selectOptions, agentOverrides);
      },
      create_issue: async ({ task: confirmedTask }) => {
        const labels = await promptLabelSelection(lang);
        await createIssueAndSaveTask(resolvedCwd, confirmedTask, workflowId, {
          confirmAtEndMessage: 'Add this issue to tasks?',
          labels,
          ...(result.attachments ? { attachments: result.attachments } : {}),
        });
      },
      save_task: async ({ task: confirmedTask }) => {
        if (prNumber !== undefined) {
          if (prBranch === undefined) {
            logError('Fetched PR head branch is required when saving a PR review task.');
            process.exit(1);
          }
          await saveTaskFromInteractive(resolvedCwd, confirmedTask, workflowId, {
            prNumber,
            presetSettings: {
              worktree: true,
              branch: prBranch,
              autoPr: true,
              ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
            },
            ...(result.attachments ? { attachments: result.attachments } : {}),
          });
          return;
        }
        await saveTaskFromInteractive(resolvedCwd, confirmedTask, workflowId, {
          ...(sourceIssueNumber !== undefined ? { issue: sourceIssueNumber } : {}),
          ...(result.attachments ? { attachments: result.attachments } : {}),
        });
      },
      cancel: () => undefined,
    });
  } finally {
    cleanupInteractiveResultAttachments(result);
  }
}
