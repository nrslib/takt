import { info, success, error as logError } from '../../shared/ui/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../shared/utils/index.js';
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
  personaMode,
  resolveLanguage,
  dispatchConversationAction,
  type InteractiveModeResult,
  type ConversationDispatchOutcome,
} from '../../features/interactive/index.js';
import { cleanupInteractiveResultAttachments } from '../../features/interactive/imageAttachments.js';
import { INTERACTIVE_MODES } from '../../core/models/index.js';
import {
  getWorkflowDescription,
  loadWorkflowByIdentifier,
  resolveConfigValue,
  resolveConfigValues,
  loadPersonaSessions,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { resolveAssistantProviderModel } from '../../features/interactive/assistantConfig.js';
import { program } from './program.js';
import { getCliExecutionContext } from './initialization.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { loadTaskHistory } from './taskHistory.js';
import { resolveIssueInput, resolvePrInput } from './routing-inputs.js';
import { createPullRequestContext } from '../../core/workflow/pr-context.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { getAssistantSessionPersona } from '../../features/interactive/assistantMode.js';

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
    failureMode: 'exit',
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

  // Decided before the PR/Issue fetch so the run can be refused on the spot. A
  // terminal always gets the TUI; without one the conversation falls back to the
  // readline flow that piped input relies on, and `--tui` refuses to pretend.
  const hasTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (opts.tui === true && !hasTerminal) {
    logError(getLabel(
      'tui.errors.requiresTty',
      resolveLanguage(resolveConfigValues(resolvedCwd, ['language']).language),
    ));
    process.exit(1);
  }
  const useTui = hasTerminal;

  let directTask: string | undefined = task;
  let sourceContext: string | undefined;
  let prBranch: string | undefined;
  let prBaseBranch: string | undefined;
  let sourcePrNumber = prNumber;
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
      if (prBranch !== undefined) {
        selectOptions.prContext = createPullRequestContext({
          source: 'pr_review',
          prNumber,
          baseBranch: resolvedPrBase,
          headBranch: prBranch,
          baseBranchSource: prBaseBranch === undefined ? 'default_branch_fallback' : 'pull_request',
        });
      }
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

  if (useTui) {
    // An explicit --workflow is loaded up front so a typo fails the command
    // instead of the run: it covers names and paths alike, and a blank or
    // missing value falls through to the selector the TUI run opens itself.
    if (resolvedWorkflow) {
      if (loadWorkflowByIdentifier(resolvedWorkflow, resolvedCwd) === null) {
        logError(getLabel('tui.errors.workflowNotFound', lang, {
          workflow: sanitizeTerminalText(resolvedWorkflow),
        }));
        process.exit(1);
      }
    }
    const { runTui } = await import('../../features/tui/index.js');
    const run = await runTui({
      cwd: resolvedCwd,
      lang,
      previewCount: globalConfig.interactivePreviewSteps,
      taskHistory: loadTaskHistory(resolvedCwd, lang),
      ...(resolvedWorkflow ? { workflowId: resolvedWorkflow } : {}),
      ...(agentOverrides ? { agentOverrides } : {}),
      ...(directTask ? { userMessage: directTask } : {}),
      ...(sourceContext ? { sourceContext } : {}),
      ...(prBranch ? { excludeActions: ['create_issue'] as const } : {}),
      ...(opts.continue === true ? { continueSession: true } : {}),
      // The session stays open: each decision runs here and the conversation
      // takes the next one, until the user leaves it.
      dispatch: async (workflowId, actionResult) => {
        const outcome = await dispatchConversation(workflowId, actionResult);
        return outcome.kind === 'cancelled' ? outcome : undefined;
      },
    });
    if (run.kind === 'cancelled') {
      info(getLabel('interactive.ui.cancelled', lang));
      return;
    }
    // A resident session dispatches each task as it happens and returns here
    // with the final decision that ended the run. Dispatching it also releases
    // any attachments still owned by that result.
    await finishConversation(run.workflowId, run.result);
    return;
  }

  const workflowId = await determineWorkflow(resolvedCwd, selectOptions.workflow);
  if (workflowId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const previewCount = globalConfig.interactivePreviewSteps;
  const workflowDesc = getWorkflowDescription(
    workflowId,
    resolvedCwd,
    previewCount,
    resolvedCwd,
    agentOverrides,
  );

  const loadWorkflowContext = () => ({
    name: workflowDesc.name,
    description: workflowDesc.description,
    workflowStructure: workflowDesc.workflowStructure,
    stepPreviews: workflowDesc.stepPreviews,
    taskHistory: loadTaskHistory(resolvedCwd, lang),
  });
  let result: InteractiveModeResult;
  let dispatchCompletedInLoop = false;
  const dispatchSelectedAction = async (
    actionResult: InteractiveModeResult,
  ): Promise<ConversationDispatchOutcome> => {
    const outcome = await dispatchConversation(workflowId, actionResult);
    if (outcome.kind === 'dispatched') {
      dispatchCompletedInLoop = true;
    }
    return outcome;
  };
  const assistantOverrideProvider = agentOverrides?.provider;

  {
    const selectedMode = await selectInteractiveMode(
      lang,
      INTERACTIVE_MODES,
    );
    if (selectedMode === null) {
      info(getLabel('interactive.ui.cancelled', lang));
      return;
    }

    const workflowContext = loadWorkflowContext();
    const interactiveSeed = directTask || sourceContext
      ? {
        ...(directTask ? { userMessage: directTask } : {}),
        ...(sourceContext ? { sourceContext } : {}),
      }
      : undefined;

    switch (selectedMode) {
      case 'assistant':
      case 'grill-me': {
        const assistantMode = selectedMode;
        let selectedSessionId: string | undefined;
        if (opts.continue === true) {
          const { provider } = resolveAssistantProviderModel(resolvedCwd, {
            provider: assistantOverrideProvider,
            model: agentOverrides?.model,
          });
          if (!provider) {
            throw new Error('Provider is not configured.');
          }
          const savedSessions = loadPersonaSessions(resolvedCwd, provider);
          const savedSessionId = resolvePersonaSessionId(
            savedSessions,
            getAssistantSessionPersona(assistantMode),
            provider,
          );
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
          ...(assistantMode === 'grill-me' ? { assistantMode } : {}),
          dispatch: dispatchSelectedAction,
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

      case 'persona': {
        if (!workflowDesc.firstStep) {
          info(getLabel('interactive.ui.personaFallback', lang));
          result = await interactiveMode(
            resolvedCwd,
            interactiveSeed,
            workflowContext,
            undefined,
            undefined,
            { dispatch: dispatchSelectedAction },
          );
        } else {
          result = await personaMode(
            resolvedCwd,
            workflowDesc.firstStep,
            interactiveSeed,
            workflowContext,
            { dispatch: dispatchSelectedAction },
          );
        }
        break;
      }
    }
  }

  await finishConversation(workflowId, result, dispatchCompletedInLoop);

  async function finishConversation(
    chosenWorkflowId: string,
    conversationResult: InteractiveModeResult,
    dispatchCompleted = false,
  ): Promise<void> {
    try {
      if (!dispatchCompleted) {
        await dispatchConversation(chosenWorkflowId, conversationResult);
      }
    } finally {
      cleanupInteractiveResultAttachments(conversationResult);
    }
  }

  /**
   * Runs what the conversation decided on. The attachments are left alone: a
   * resident TUI session pastes into the same store after this returns, and the
   * caller that owns the store cleans it up when the session ends.
   */
  async function dispatchConversation(
    chosenWorkflowId: string,
    conversationResult: InteractiveModeResult,
  ): Promise<ConversationDispatchOutcome> {
    if (conversationResult.issueContextReplacement !== undefined) {
      sourcePrNumber = undefined;
      prBranch = undefined;
      prBaseBranch = undefined;
      delete selectOptions.prContext;
      sourceIssueNumber = conversationResult.issueContextReplacement.issueNumber;
      selectOptions.traceTaskContext = {
        source: 'issue',
        ...(sourceIssueNumber === undefined ? {} : { issueNumber: sourceIssueNumber }),
      };
    }
    return dispatchConversationAction(conversationResult, {
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
        selectOptions.workflow = chosenWorkflowId;
        selectOptions.interactiveMetadata = { confirmed: true, task: confirmedTask };
        selectOptions.skipTaskList = true;
        if (conversationResult.attachments) {
          selectOptions.attachments = conversationResult.attachments;
        }
        await selectAndExecuteTask(resolvedCwd, confirmedTask, {
          ...selectOptions,
          failureMode: useTui ? 'return' : 'exit',
        }, agentOverrides);
        return { kind: 'dispatched' };
      },
      create_issue: async ({ task: confirmedTask }) => {
        const labels = await promptLabelSelection(lang);
        await createIssueAndSaveTask(resolvedCwd, confirmedTask, chosenWorkflowId, {
          labels,
          ...(sourceIssueNumber !== undefined
            ? { sourceIssue: { number: sourceIssueNumber, language: lang } }
            : {}),
          ...(conversationResult.attachments ? { attachments: conversationResult.attachments } : {}),
        });
        return { kind: 'dispatched' };
      },
      save_task: async ({ task: confirmedTask }) => {
        if (sourcePrNumber !== undefined) {
          if (prBranch === undefined) {
            logError('Fetched PR head branch is required when saving a PR review task.');
            process.exit(1);
          }
          await saveTaskFromInteractive(resolvedCwd, confirmedTask, chosenWorkflowId, {
            prNumber: sourcePrNumber,
            presetSettings: {
              worktree: true,
              branch: prBranch,
              autoPr: true,
              ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
            },
            ...(conversationResult.attachments ? { attachments: conversationResult.attachments } : {}),
          });
          return { kind: 'dispatched' };
        }
        const saveResult = await saveTaskFromInteractive(resolvedCwd, confirmedTask, chosenWorkflowId, {
          ...(sourceIssueNumber !== undefined ? { issue: sourceIssueNumber } : {}),
          allowCancel: true,
          ...(conversationResult.attachments ? { attachments: conversationResult.attachments } : {}),
        });
        return saveResult !== undefined
          && 'kind' in saveResult
          && saveResult.kind === 'cancelled'
          ? { kind: 'cancelled' }
          : { kind: 'dispatched' };
      },
      cancel: () => ({ kind: 'dispatched' }),
    });
  }
}
