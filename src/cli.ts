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
  reviewTasks,
} from './commands/index.js';
import { listWorkflows } from './config/workflowLoader.js';
import { selectOptionWithDefault, confirm } from './prompt/index.js';
import { createWorktree } from './task/worktree.js';
import { autoCommitWorktree } from './task/autoCommit.js';
import { DEFAULT_WORKFLOW_NAME } from './constants.js';

const log = createLogger('cli');

export interface WorktreeConfirmationResult {
  execCwd: string;
  isWorktree: boolean;
}

/**
 * Ask user whether to create a worktree, and create one if confirmed.
 * Returns the execution directory and whether a worktree was created.
 */
export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
): Promise<WorktreeConfirmationResult> {
  const useWorktree = await confirm('Create worktree?', false);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  const result = createWorktree(cwd, {
    worktree: true,
    taskSlug: task,
  });
  info(`Worktree created: ${result.path} (branch: ${result.branch})`);

  return { execCwd: result.path, isWorktree: true };
}

const program = new Command();

program
  .name('takt')
  .description('TAKT: Task Agent Koordination Tool')
  .version('0.1.0');

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
      version: '0.1.0',
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
        case 'run-tasks': {
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
          await addTask(cwd, args);
          return;

        case 'refresh-builtin':
          await refreshBuiltin();
          return;

        case 'watch':
          await watchTasks(cwd);
          return;

        case 'review-tasks':
        case 'review':
          await reviewTasks(cwd);
          return;

        default:
          error(`Unknown command: /${command}`);
          info('Available: /run-tasks, /watch, /add-task, /review-tasks, /switch, /clear, /refresh-builtin, /help, /config');
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
      const taskSuccess = await executeTask(task, execCwd, selectedWorkflow);

      if (taskSuccess && isWorktree) {
        const commitResult = autoCommitWorktree(execCwd, task);
        if (commitResult.success && commitResult.commitHash) {
          success(`Auto-committed: ${commitResult.commitHash}`);
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
