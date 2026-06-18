import { error as logError } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { selectAndExecuteTask, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { resolveIssueInput, resolvePrInput } from './routing-inputs.js';
import { runInteractiveLoop } from './interactiveLoop.js';

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
      selectOptions.traceTaskContext = {
        source: 'pr_review',
        prNumber,
        branch: prBranch,
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
      };
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

  await runInteractiveLoop({
    cwd: resolvedCwd,
    selectOptions,
    directTask,
    sourceContext,
    prBranch,
    prBaseBranch,
    prNumber,
    sourceIssueNumber,
    continuePreviousSession: opts.continue === true,
    agentOverrides,
  });
}

program
  .argument('[task]', 'Task to execute (or issue reference like "#6")')
  .action(executeDefaultAction);
