#!/usr/bin/env node

/**
 * TAKT CLI - Task Agent Koordination Tool
 *
 * Usage:
 *   takt {task}       - Execute task with current workflow (continues session)
 *   takt #99          - Execute task from GitHub issue
 *   takt run          - Run all pending tasks from .takt/tasks/
 *   takt switch       - Switch workflow interactively
 *   takt clear        - Clear agent conversation sessions (reset to initial state)
 *   takt --help       - Show help
 *   takt config       - Select permission mode interactively
 *
 * Pipeline (non-interactive):
 *   takt --task "fix bug" -w magi --auto-pr
 *   takt --task "fix bug" --issue 99 --auto-pr
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { resolve } from 'node:path';
import {
  initGlobalDirs,
  initProjectDirs,
  loadGlobalConfig,
  getEffectiveDebugConfig,
} from './config/index.js';
import { clearAgentSessions, getCurrentWorkflow, isVerboseMode } from './config/paths.js';
import { info, error, success, setLogLevel } from './utils/ui.js';
import { initDebugLogger, createLogger, setVerboseConsole } from './utils/debug.js';
import {
  executeTask,
  runAllTasks,
  switchWorkflow,
  switchConfig,
  addTask,
  ejectBuiltin,
  watchTasks,
  listTasks,
  interactiveMode,
  executePipeline,
} from './commands/index.js';
import { listWorkflows } from './config/workflowLoader.js';
import { selectOptionWithDefault, confirm } from './prompt/index.js';
import { createSharedClone } from './task/clone.js';
import { autoCommitAndPush } from './task/autoCommit.js';
import { summarizeTaskName } from './task/summarize.js';
import { DEFAULT_WORKFLOW_NAME } from './constants.js';
import { checkForUpdates } from './utils/updateNotifier.js';
import { resolveIssueTask, isIssueReference } from './github/issue.js';
import { createPullRequest, buildPrBody } from './github/pr.js';
import type { TaskExecutionOptions } from './commands/taskExecution.js';
import type { ProviderType } from './providers/index.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../package.json') as { version: string };

const log = createLogger('cli');

checkForUpdates();

/** Resolved cwd shared across commands via preAction hook */
let resolvedCwd = '';

/** Whether pipeline mode is active (--task specified, set in preAction) */
let pipelineMode = false;

export interface WorktreeConfirmationResult {
  execCwd: string;
  isWorktree: boolean;
  branch?: string;
}

/**
 * Select a workflow interactively.
 * Returns the selected workflow name, or null if cancelled.
 */
async function selectWorkflow(cwd: string): Promise<string | null> {
  const availableWorkflows = listWorkflows();
  const currentWorkflow = getCurrentWorkflow(cwd);

  if (availableWorkflows.length === 0) {
    info(`No workflows found. Using default: ${DEFAULT_WORKFLOW_NAME}`);
    return DEFAULT_WORKFLOW_NAME;
  }

  if (availableWorkflows.length === 1 && availableWorkflows[0]) {
    return availableWorkflows[0];
  }

  const options = availableWorkflows.map((name) => ({
    label: name === currentWorkflow ? `${name} (current)` : name,
    value: name,
  }));

  const defaultWorkflow = availableWorkflows.includes(currentWorkflow)
    ? currentWorkflow
    : (availableWorkflows.includes(DEFAULT_WORKFLOW_NAME)
        ? DEFAULT_WORKFLOW_NAME
        : availableWorkflows[0] || DEFAULT_WORKFLOW_NAME);

  return selectOptionWithDefault('Select workflow:', options, defaultWorkflow);
}

/**
 * Execute a task with workflow selection, optional worktree, and auto-commit.
 * Shared by direct task execution and interactive mode.
 */
export interface SelectAndExecuteOptions {
  autoPr?: boolean;
  repo?: string;
  workflow?: string;
  createWorktree?: boolean | undefined;
}

async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void> {
  const selectedWorkflow = await determineWorkflow(cwd, options?.workflow);

  if (selectedWorkflow === null) {
    info('Cancelled');
    return;
  }

  const { execCwd, isWorktree, branch } = await confirmAndCreateWorktree(
    cwd,
    task,
    options?.createWorktree,
  );

  log.info('Starting task execution', { workflow: selectedWorkflow, worktree: isWorktree });
  const taskSuccess = await executeTask(task, execCwd, selectedWorkflow, cwd, agentOverrides);

  if (taskSuccess && isWorktree) {
    const commitResult = autoCommitAndPush(execCwd, task, cwd);
    if (commitResult.success && commitResult.commitHash) {
      success(`Auto-committed & pushed: ${commitResult.commitHash}`);
    } else if (!commitResult.success) {
      error(`Auto-commit failed: ${commitResult.message}`);
    }

    // PR creation: --auto-pr → create automatically, otherwise ask
    if (commitResult.success && commitResult.commitHash && branch) {
      const shouldCreatePr = options?.autoPr === true || await confirm('Create pull request?', false);
      if (shouldCreatePr) {
        info('Creating pull request...');
        const prBody = buildPrBody(undefined, `Workflow \`${selectedWorkflow}\` completed successfully.`);
        const prResult = createPullRequest(execCwd, {
          branch,
          title: task.length > 100 ? `${task.slice(0, 97)}...` : task,
          body: prBody,
          repo: options?.repo,
        });
        if (prResult.success) {
          success(`PR created: ${prResult.url}`);
        } else {
          error(`PR creation failed: ${prResult.error}`);
        }
      }
    }
  }

  if (!taskSuccess) {
    process.exit(1);
  }
}

/**
 * Ask user whether to create a shared clone, and create one if confirmed.
 * Returns the execution directory and whether a clone was created.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
async function determineWorkflow(cwd: string, override?: string): Promise<string | null> {
  if (override) {
    const availableWorkflows = listWorkflows();
    const knownWorkflows = availableWorkflows.length === 0 ? [DEFAULT_WORKFLOW_NAME] : availableWorkflows;
    if (!knownWorkflows.includes(override)) {
      error(`Workflow not found: ${override}`);
      return null;
    }
    return override;
  }
  return selectWorkflow(cwd);
}

export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
  createWorktreeOverride?: boolean | undefined,
): Promise<WorktreeConfirmationResult> {
  const useWorktree =
    typeof createWorktreeOverride === 'boolean'
      ? createWorktreeOverride
      : await confirm('Create worktree?', true);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  // Summarize task name to English slug using AI
  info('Generating branch name...');
  const taskSlug = await summarizeTaskName(task, { cwd });

  const result = createSharedClone(cwd, {
    worktree: true,
    taskSlug,
  });
  info(`Clone created: ${result.path} (branch: ${result.branch})`);

  return { execCwd: result.path, isWorktree: true, branch: result.branch };
}

const program = new Command();

function resolveAgentOverrides(): TaskExecutionOptions | undefined {
  const opts = program.opts();
  const provider = opts.provider as ProviderType | undefined;
  const model = opts.model as string | undefined;

  if (!provider && !model) {
    return undefined;
  }

  return { provider, model };
}

function parseCreateWorktreeOption(value?: string): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'yes' || normalized === 'true') {
    return true;
  }
  if (normalized === 'no' || normalized === 'false') {
    return false;
  }

  error('Invalid value for --create-worktree. Use yes or no.');
  process.exit(1);
}

program
  .name('takt')
  .description('TAKT: Task Agent Koordination Tool')
  .version(cliVersion);

// --- Global options ---
program
  .option('-i, --issue <number>', 'GitHub issue number (equivalent to #N)', (val: string) => parseInt(val, 10))
  .option('-w, --workflow <name>', 'Workflow to use')
  .option('-b, --branch <name>', 'Branch name (auto-generated if omitted)')
  .option('--auto-pr', 'Create PR after successful execution')
  .option('--repo <owner/repo>', 'Repository (defaults to current)')
  .option('--provider <name>', 'Override agent provider (claude|codex|mock)')
  .option('--model <name>', 'Override agent model')
  .option('-t, --task <string>', 'Task content (as alternative to GitHub issue)')
  .option('--pipeline', 'Pipeline mode: non-interactive, no worktree, direct branch creation')
  .option('--skip-git', 'Skip branch creation, commit, and push (pipeline mode)')
  .option('--create-worktree <yes|no>', 'Skip the worktree prompt by explicitly specifying yes or no');

// Common initialization for all commands
program.hook('preAction', async () => {
  resolvedCwd = resolve(process.cwd());

  // Pipeline mode: triggered by --pipeline flag
  const rootOpts = program.opts();
  pipelineMode = rootOpts.pipeline === true;

  await initGlobalDirs({ nonInteractive: pipelineMode });
  initProjectDirs(resolvedCwd);

  const verbose = isVerboseMode(resolvedCwd);
  let debugConfig = getEffectiveDebugConfig(resolvedCwd);

  if (verbose && (!debugConfig || !debugConfig.enabled)) {
    debugConfig = { enabled: true };
  }

  initDebugLogger(debugConfig, resolvedCwd);

  if (verbose) {
    setVerboseConsole(true);
    setLogLevel('debug');
  } else {
    const config = loadGlobalConfig();
    setLogLevel(config.logLevel);
  }

  log.info('TAKT CLI starting', { version: cliVersion, cwd: resolvedCwd, verbose, pipelineMode });
});

// --- Subcommands ---

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks/')
  .action(async () => {
    const workflow = getCurrentWorkflow(resolvedCwd);
    await runAllTasks(resolvedCwd, workflow, resolveAgentOverrides());
  });

program
  .command('watch')
  .description('Watch for tasks and auto-execute')
  .action(async () => {
    await watchTasks(resolvedCwd, resolveAgentOverrides());
  });

program
  .command('add')
  .description('Add a new task (interactive AI conversation)')
  .argument('[task]', 'Task description or GitHub issue reference (e.g. "#28")')
  .action(async (task?: string) => {
    await addTask(resolvedCwd, task);
  });

program
  .command('list')
  .description('List task branches (merge/delete)')
  .action(async () => {
    await listTasks(resolvedCwd, resolveAgentOverrides());
  });

program
  .command('switch')
  .description('Switch workflow interactively')
  .argument('[workflow]', 'Workflow name')
  .action(async (workflow?: string) => {
    await switchWorkflow(resolvedCwd, workflow);
  });

program
  .command('clear')
  .description('Clear agent conversation sessions')
  .action(() => {
    clearAgentSessions(resolvedCwd);
    success('Agent sessions cleared');
  });

program
  .command('eject')
  .description('Copy builtin workflow/agents to ~/.takt/ for customization')
  .argument('[name]', 'Specific builtin to eject')
  .action(async (name?: string) => {
    await ejectBuiltin(name);
  });

program
  .command('config')
  .description('Configure settings (permission mode)')
  .argument('[key]', 'Configuration key')
  .action(async (key?: string) => {
    await switchConfig(resolvedCwd, key);
  });

// --- Default action: task execution, interactive mode, or pipeline ---

/**
 * Check if the input is a task description (should execute directly)
 * vs a short input that should enter interactive mode as initial input.
 *
 * Task descriptions: contain spaces, or are issue references (#N).
 * Short single words: routed to interactive mode as first message.
 */
function isDirectTask(input: string): boolean {
  // Multi-word input is a task description
  if (input.includes(' ')) return true;
  // Issue references are direct tasks
  if (isIssueReference(input) || input.trim().split(/\s+/).every((t: string) => isIssueReference(t))) return true;
  return false;
}


program
  .argument('[task]', 'Task to execute (or GitHub issue reference like "#6")')
  .action(async (task?: string) => {
    const opts = program.opts();
    const agentOverrides = resolveAgentOverrides();
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
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      return;
    }

    if (task && isDirectTask(task)) {
      // Resolve #N issue references to task text
      let resolvedTask: string = task;
      if (isIssueReference(task) || task.trim().split(/\s+/).every((t: string) => isIssueReference(t))) {
        try {
          info('Fetching GitHub Issue...');
          resolvedTask = resolveIssueTask(task);
        } catch (e) {
          error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }
      }

      await selectAndExecuteTask(resolvedCwd, resolvedTask, selectOptions, agentOverrides);
      return;
    }

    // Short single word or no task → interactive mode (with optional initial input)
    const result = await interactiveMode(resolvedCwd, task);

    if (!result.confirmed) {
      return;
    }

    await selectAndExecuteTask(resolvedCwd, result.task, selectOptions, agentOverrides);
  });

program.parse();
