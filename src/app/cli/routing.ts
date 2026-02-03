/**
 * Default action routing
 *
 * Handles the default (no subcommand) action: task execution,
 * pipeline mode, or interactive mode.
 */

import { info, error } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { resolveIssueTask, isIssueReference } from '../../infra/github/index.js';
import { selectAndExecuteTask, determineWorkflow, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import { interactiveMode } from '../../features/interactive/index.js';
import { getWorkflowDescription } from '../../infra/config/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, parseCreateWorktreeOption, isDirectTask } from './helpers.js';

program
  .argument('[task]', 'Task to execute (or GitHub issue reference like "#6")')
  .action(async (task?: string) => {
    const opts = program.opts();
    const agentOverrides = resolveAgentOverrides(program);
    const createWorktreeOverride = parseCreateWorktreeOption(opts.createWorktree as string | undefined);
    const selectOptions: SelectAndExecuteOptions = {
      autoPr: opts.autoPr === true,
      repo: opts.repo as string | undefined,
      workflow: opts.workflow as string | undefined,
      createWorktree: createWorktreeOverride,
    };

    // --- Pipeline mode (non-interactive): triggered by --pipeline ---
    if (pipelineMode) {
      const exitCode = await executePipeline({
        issueNumber: opts.issue as number | undefined,
        task: opts.task as string | undefined,
        workflow: (opts.workflow as string | undefined) ?? DEFAULT_WORKFLOW_NAME,
        branch: opts.branch as string | undefined,
        autoPr: opts.autoPr === true,
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

    // --- Normal (interactive) mode ---

    // Resolve --task option to task text
    const taskFromOption = opts.task as string | undefined;
    if (taskFromOption) {
      await selectAndExecuteTask(resolvedCwd, taskFromOption, selectOptions, agentOverrides);
      return;
    }

    // Resolve --issue N to task text (same as #N)
    const issueFromOption = opts.issue as number | undefined;
    if (issueFromOption) {
      try {
        const resolvedTask = resolveIssueTask(`#${issueFromOption}`);
        await selectAndExecuteTask(resolvedCwd, resolvedTask, selectOptions, agentOverrides);
      } catch (e) {
        error(getErrorMessage(e));
        process.exit(1);
      }
      return;
    }

    if (task && isDirectTask(task)) {
      let resolvedTask: string = task;
      if (isIssueReference(task) || task.trim().split(/\s+/).every((t: string) => isIssueReference(t))) {
        try {
          info('Fetching GitHub Issue...');
          resolvedTask = resolveIssueTask(task);
        } catch (e) {
          error(getErrorMessage(e));
          process.exit(1);
        }
      }

      await selectAndExecuteTask(resolvedCwd, resolvedTask, selectOptions, agentOverrides);
      return;
    }

    // Short single word or no task → interactive mode (with optional initial input)
    const workflowId = await determineWorkflow(resolvedCwd, selectOptions.workflow);
    if (workflowId === null) {
      info('Cancelled');
      return;
    }

    const workflowContext = getWorkflowDescription(workflowId, resolvedCwd);
    const result = await interactiveMode(resolvedCwd, task, workflowContext);

    if (!result.confirmed) {
      return;
    }

    selectOptions.interactiveUserInput = true;
    selectOptions.workflow = workflowId;
    await selectAndExecuteTask(resolvedCwd, result.task, selectOptions, agentOverrides);
  });
