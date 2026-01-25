#!/usr/bin/env node

/**
 * TAKT CLI - Task Agent Koordination Tool
 *
 * Usage:
 *   takt {task}       - Execute task with current workflow (new session)
 *   takt -r {task}    - Execute task, resuming previous session
 *   takt /run-tasks   - Run all pending tasks from .takt/tasks/
 *   takt /switch      - Switch workflow interactively
 *   takt /clear       - Clear agent conversation sessions
 *   takt /help        - Show help
 *   takt /config      - Select permission mode interactively
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import {
  initGlobalDirs,
  loadGlobalConfig,
  getEffectiveDebugConfig,
} from './config/index.js';
import { clearAgentSessions, getCurrentWorkflow, isVerboseMode } from './config/paths.js';
import { info, error, success, setLogLevel } from './utils/ui.js';
import { initDebugLogger, createLogger } from './utils/debug.js';
import {
  executeTask,
  runAllTasks,
  showHelp,
  switchWorkflow,
  switchConfig,
} from './commands/index.js';
import { listWorkflows } from './config/workflowLoader.js';
import { selectOptionWithDefault } from './prompt/index.js';
import { DEFAULT_WORKFLOW_NAME } from './constants.js';

const log = createLogger('cli');

const program = new Command();

program
  .name('takt')
  .description('TAKT: Task Agent Koordination Tool')
  .version('0.1.0');

program
  .argument('[task]', 'Task to execute or slash command')
  .option('-r, --resume', 'Resume previous session (continue agent conversations)')
  .action(async (task, options: { resume?: boolean }) => {
    const resumeSession = options.resume ?? false;
    const cwd = resolve(process.cwd());

    // Initialize global directories first
    await initGlobalDirs();

    // Initialize debug logger from config
    const debugConfig = getEffectiveDebugConfig(cwd);
    initDebugLogger(debugConfig, cwd);

    log.info('TAKT CLI starting', {
      version: '0.1.0',
      cwd,
      task: task || null,
    });

    // Set log level from config
    if (isVerboseMode(cwd)) {
      setLogLevel('debug');
      log.debug('Verbose mode enabled (from config)');
    } else {
      const config = loadGlobalConfig();
      setLogLevel(config.logLevel);
    }

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

        default:
          error(`Unknown command: /${command}`);
          info('Available: /run-tasks, /switch, /clear, /help, /config');
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

        selectedWorkflow = await selectOptionWithDefault(
          'Select workflow:',
          options,
          defaultWorkflow
        );
      }

      log.info('Starting task execution', { task, workflow: selectedWorkflow, resumeSession });
      const taskSuccess = await executeTask(task, cwd, selectedWorkflow, { resumeSession });
      if (!taskSuccess) {
        process.exit(1);
      }
      return;
    }

    // No task provided - show help
    showHelp();
  });

program.parse();
