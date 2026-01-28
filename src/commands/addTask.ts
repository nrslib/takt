/**
 * /add-task command implementation
 *
 * Creates a new task file in .takt/tasks/ with YAML format.
 * Supports worktree and branch options.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { promptInput, confirm, selectOption } from '../prompt/index.js';
import { success, info } from '../utils/ui.js';
import { slugify } from '../utils/slug.js';
import { createLogger } from '../utils/debug.js';
import { listWorkflows } from '../config/workflowLoader.js';
import { getCurrentWorkflow } from '../config/paths.js';
import type { TaskFileData } from '../task/schema.js';

const log = createLogger('add-task');

/**
 * Generate a unique task filename
 */
function generateFilename(tasksDir: string, taskContent: string): string {
  const slug = slugify(taskContent);
  const base = slug || 'task';
  let filename = `${base}.yaml`;
  let counter = 1;

  while (fs.existsSync(path.join(tasksDir, filename))) {
    filename = `${base}-${counter}.yaml`;
    counter++;
  }

  return filename;
}

/**
 * /add-task command handler
 *
 * Usage:
 *   takt /add-task "タスク内容"              # Quick add (no worktree)
 *   takt /add-task                            # Interactive mode
 */
export async function addTask(cwd: string, args: string[]): Promise<void> {
  const tasksDir = path.join(cwd, '.takt', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  let taskContent: string;
  let worktree: boolean | string | undefined;
  let branch: string | undefined;
  let workflow: string | undefined;

  if (args.length > 0) {
    // Argument mode: task content provided directly
    taskContent = args.join(' ');
  } else {
    // Interactive mode
    const input = await promptInput('Task content');
    if (!input) {
      info('Cancelled.');
      return;
    }
    taskContent = input;
  }

  // Ask about worktree
  const useWorktree = await confirm('Create worktree?', false);
  if (useWorktree) {
    const customPath = await promptInput('Worktree path (Enter for auto)');
    worktree = customPath || true;

    // Ask about branch
    const customBranch = await promptInput('Branch name (Enter for auto)');
    if (customBranch) {
      branch = customBranch;
    }
  }

  // Ask about workflow using interactive selector
  const availableWorkflows = listWorkflows();
  if (availableWorkflows.length > 0) {
    const currentWorkflow = getCurrentWorkflow(cwd);
    const defaultWorkflow = availableWorkflows.includes(currentWorkflow)
      ? currentWorkflow
      : availableWorkflows[0]!;
    const options = availableWorkflows.map((name) => ({
      label: name === currentWorkflow ? `${name} (current)` : name,
      value: name,
    }));
    const selected = await selectOption('Select workflow:', options);
    if (selected && selected !== defaultWorkflow) {
      workflow = selected;
    }
  }

  // Build task data
  const taskData: TaskFileData = { task: taskContent };
  if (worktree !== undefined) {
    taskData.worktree = worktree;
  }
  if (branch) {
    taskData.branch = branch;
  }
  if (workflow) {
    taskData.workflow = workflow;
  }

  // Write YAML filea
  const filename = generateFilename(tasksDir, taskContent);
  const filePath = path.join(tasksDir, filename);
  const yamlContent = stringifyYaml(taskData);
  fs.writeFileSync(filePath, yamlContent, 'utf-8');

  log.info('Task created', { filePath, taskData });

  success(`Task created: ${filename}`);
  info(`  Path: ${filePath}`);
  if (worktree) {
    info(`  Worktree: ${typeof worktree === 'string' ? worktree : 'auto'}`);
  }
  if (branch) {
    info(`  Branch: ${branch}`);
  }
  if (workflow) {
    info(`  Workflow: ${workflow}`);
  }
}
