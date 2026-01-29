#!/usr/bin/env node

/**
 * TAKT CLI - Task Agent Koordination Tool
 *
 * Usage:
 *   takt {task}       - Execute task with current workflow (continues session)
 *   takt /run-tasks   - Run all pending tasks from .takt/tasks/
 *   takt /switch      - Switch workflow interactively
 *   takt /clear       - Clear agent conversation sessions (reset to initial state)
 *   takt /help        - Show help
 *   takt /config      - Select permission mode interactively
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
  showHelp,
  switchWorkflow,
  switchConfig,
  addTask,
  refreshBuiltin,
  watchTasks,
  listTasks,
} from './commands/index.js';
import { listWorkflows } from './config/workflowLoader.js';
import { selectOptionWithDefault, confirm } from './prompt/index.js';
import { createSharedClone } from './task/clone.js';
import { autoCommitAndPush } from './task/autoCommit.js';
import { summarizeTaskName } from './task/summarize.js';
import { DEFAULT_WORKFLOW_NAME } from './constants.js';
import { checkForUpdates } from './utils/updateNotifier.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../package.json') as { version: string };

const log = createLogger('cli');

checkForUpdates();

export interface WorktreeConfirmationResult {
  execCwd: string;
  isWorktree: boolean;
  branch?: string;
}

/**
 * Ask user whether to create a shared clone, and create one if confirmed.
 * Returns the execution directory and whether a clone was created.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
): Promise<WorktreeConfirmationResult> {
  const useWorktree = await confirm('Create worktree?', false);

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

program
  .name('takt')
  .description('TAKT: Task Agent Koordination Tool')
  .version(cliVersion);

program
  .argument('[task]', 'Task to execute or slash command')
  .action(async (task) => {
    const cwd = resolve(process.cwd());

    // Initialize global directories first
    await initGlobalDirs();

    // Initialize project directories (.takt/)
    initProjectDirs(cwd);

    // Determine verbose mode and initialize logging
    const verbose = isVerboseMode(cwd);
    let debugConfig = getEffectiveDebugConfig(cwd);

    // verbose=true enables file logging automatically
    if (verbose && (!debugConfig || !debugConfig.enabled)) {
      debugConfig = { enabled: true };
    }

    initDebugLogger(debugConfig, cwd);

    // Enable verbose console output (stderr) for debug logs
    if (verbose) {
      setVerboseConsole(true);
      setLogLevel('debug');
    } else {
      const config = loadGlobalConfig();
      setLogLevel(config.logLevel);
    }

    log.info('TAKT CLI starting', {
      version: cliVersion,
      cwd,
      task: task || null,
      verbose,
    });

    // Handle slash commands
    if (task?.startsWith('/')) {
      const parts = task.slice(1).split(/\s+/);
      const command = parts[0]?.toLowerCase() || '';
      const args = parts.slice(1);

      switch (command) {
        case 'run-tasks':
        case 'run': {
          const workflow = getCurrentWorkflow(cwd);
          await runAllTasks(cwd, workflow);
          return;
        }

        case 'clear':
          clearAgentSessions(cwd);
          success('Agent sessions cleared');
          return;

        case 'switch':
        case 'sw':
          await switchWorkflow(cwd, args[0]);
          return;

        case 'help':
          showHelp();
          return;

        case 'config':
          await switchConfig(cwd, args[0]);
          return;

        case 'add-task':
        case 'add':
          await addTask(cwd, args);
          return;

        case 'refresh-builtin':
          await refreshBuiltin();
          return;

        case 'watch':
          await watchTasks(cwd);
          return;

        case 'list-tasks':
        case 'list':
          await listTasks(cwd);
          return;

        default:
          error(`Unknown command: /${command}`);
          info('Available: /run-tasks (/run), /watch, /add-task (/add), /list-tasks (/list), /switch (/sw), /clear, /refresh-builtin, /help, /config');
          process.exit(1);
      }
    }

    // Task execution
    if (task) {
      // Get available workflows and prompt user to select
      const availableWorkflows = listWorkflows();
      const currentWorkflow = getCurrentWorkflow(cwd);

      let selectedWorkflow: string;

      if (availableWorkflows.length === 0) {
        // No workflows available, use default
        selectedWorkflow = DEFAULT_WORKFLOW_NAME;
        info(`No workflows found. Using default: ${selectedWorkflow}`);
      } else if (availableWorkflows.length === 1 && availableWorkflows[0]) {
        // Only one workflow, use it directly
        selectedWorkflow = availableWorkflows[0];
      } else {
        // Multiple workflows, prompt user to select
        const options = availableWorkflows.map((name) => ({
          label: name === currentWorkflow ? `${name} (current)` : name,
          value: name,
        }));

        // Use current workflow as default, fallback to DEFAULT_WORKFLOW_NAME
        const defaultWorkflow = availableWorkflows.includes(currentWorkflow)
          ? currentWorkflow
          : (availableWorkflows.includes(DEFAULT_WORKFLOW_NAME)
              ? DEFAULT_WORKFLOW_NAME
              : availableWorkflows[0] || DEFAULT_WORKFLOW_NAME);

        const selected = await selectOptionWithDefault(
          'Select workflow:',
          options,
          defaultWorkflow
        );

        if (selected === null) {
          info('Cancelled');
          return;
        }

        selectedWorkflow = selected;
      }

      // Ask whether to create a worktree
      const { execCwd, isWorktree } = await confirmAndCreateWorktree(cwd, task);

      log.info('Starting task execution', { task, workflow: selectedWorkflow, worktree: isWorktree });
      const taskSuccess = await executeTask(task, execCwd, selectedWorkflow, cwd);

      if (taskSuccess && isWorktree) {
        const commitResult = autoCommitAndPush(execCwd, task, cwd);
        if (commitResult.success && commitResult.commitHash) {
          success(`Auto-committed & pushed: ${commitResult.commitHash}`);
        } else if (!commitResult.success) {
          error(`Auto-commit failed: ${commitResult.message}`);
        }
      }

      if (!taskSuccess) {
        process.exit(1);
      }
      return;
    }

    // No task provided - show help
    showHelp();
  });

program.parse();
