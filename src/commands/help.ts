/**
 * Help display
 */

import { header, info } from '../utils/ui.js';
import { getDebugLogFile } from '../utils/debug.js';

/**
 * Show help information
 */
export function showHelp(): void {
  header('TAKT - Task Agent Koordination Tool');

  console.log(`
Usage:
  takt {task}        Execute task with current workflow (continues session)
  takt /run-tasks    Run all pending tasks from .takt/tasks/
  takt /add-task     Add a new task (interactive, YAML format)
  takt /switch       Switch workflow interactively
  takt /clear        Clear agent conversation sessions (reset to initial state)
  takt /help         Show this help

Examples:
  takt "Fix the bug in main.ts"         # Execute task (continues session)
  takt /add-task "認証機能を追加する"   # Quick add task
  takt /add-task                        # Interactive task creation
  takt /clear                           # Clear sessions, start fresh
  takt /switch
  takt /run-tasks

Task files (.takt/tasks/):
  .md files    Plain text tasks (backward compatible)
  .yaml files  Structured tasks with worktree/branch/workflow options

Configuration (.takt/config.yaml):
  workflow: default    # Current workflow
  verbose: true        # Enable verbose output
`);

  // Show debug log path if enabled
  const debugLogFile = getDebugLogFile();
  if (debugLogFile) {
    info(`Debug log: ${debugLogFile}`);
  }
}
