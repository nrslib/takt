/**
 * Task execution logic
 */

import { loadWorkflowByIdentifier, isWorkflowPath, loadGlobalConfig } from '../config/index.js';
import { TaskRunner, type TaskInfo } from '../task/index.js';
import { createSharedClone } from '../task/clone.js';
import { autoCommitAndPush } from '../task/autoCommit.js';
import { summarizeTaskName } from '../task/summarize.js';
import {
  header,
  info,
  error,
  success,
  status,
  blankLine,
} from '../utils/ui.js';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { executeWorkflow } from './workflowExecution.js';
import { DEFAULT_WORKFLOW_NAME } from '../constants.js';
import type { ProviderType } from '../providers/index.js';

const log = createLogger('task');

export interface TaskExecutionOptions {
  provider?: ProviderType;
  model?: string;
}

export interface ExecuteTaskOptions {
  /** Task content */
  task: string;
  /** Working directory (may be a clone path) */
  cwd: string;
  /** Workflow name or path (auto-detected by isWorkflowPath) */
  workflowIdentifier: string;
  /** Project root (where .takt/ lives) */
  projectCwd: string;
  /** Agent provider/model overrides */
  agentOverrides?: TaskExecutionOptions;
}

/**
 * Execute a single task with workflow.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<boolean> {
  const { task, cwd, workflowIdentifier, projectCwd, agentOverrides } = options;
  const workflowConfig = loadWorkflowByIdentifier(workflowIdentifier, projectCwd);

  if (!workflowConfig) {
    if (isWorkflowPath(workflowIdentifier)) {
      error(`Workflow file not found: ${workflowIdentifier}`);
    } else {
      error(`Workflow "${workflowIdentifier}" not found.`);
      info('Available workflows are in ~/.takt/workflows/ or .takt/workflows/');
      info('Use "takt switch" to select a workflow.');
    }
    return false;
  }

  log.debug('Running workflow', {
    name: workflowConfig.name,
    steps: workflowConfig.steps.map((s: { name: string }) => s.name),
  });

  const globalConfig = loadGlobalConfig();
  const result = await executeWorkflow(workflowConfig, task, cwd, {
    projectCwd,
    language: globalConfig.language,
    provider: agentOverrides?.provider,
    model: agentOverrides?.model,
  });
  return result.success;
}

/**
 * Execute a task: resolve clone → run workflow → auto-commit+push → remove clone → record completion.
 *
 * Shared by runAllTasks() and watchTasks() to avoid duplicated
 * resolve → execute → autoCommit → complete logic.
 *
 * @returns true if the task succeeded
 */
export async function executeAndCompleteTask(
  task: TaskInfo,
  taskRunner: TaskRunner,
  cwd: string,
  workflowName: string,
  options?: TaskExecutionOptions,
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const executionLog: string[] = [];

  try {
    const { execCwd, execWorkflow, isWorktree } = await resolveTaskExecution(task, cwd, workflowName);

    // cwd is always the project root; pass it as projectCwd so reports/sessions go there
    const taskSuccess = await executeTask({
      task: task.content,
      cwd: execCwd,
      workflowIdentifier: execWorkflow,
      projectCwd: cwd,
      agentOverrides: options,
    });
    const completedAt = new Date().toISOString();

    if (taskSuccess && isWorktree) {
      const commitResult = autoCommitAndPush(execCwd, task.name, cwd);
      if (commitResult.success && commitResult.commitHash) {
        info(`Auto-committed & pushed: ${commitResult.commitHash}`);
      } else if (!commitResult.success) {
        error(`Auto-commit failed: ${commitResult.message}`);
      }
    }

    const taskResult = {
      task,
      success: taskSuccess,
      response: taskSuccess ? 'Task completed successfully' : 'Task failed',
      executionLog,
      startedAt,
      completedAt,
    };

    if (taskSuccess) {
      taskRunner.completeTask(taskResult);
      success(`Task "${task.name}" completed`);
    } else {
      taskRunner.failTask(taskResult);
      error(`Task "${task.name}" failed`);
    }

    return taskSuccess;
  } catch (err) {
    const completedAt = new Date().toISOString();

    taskRunner.failTask({
      task,
      success: false,
      response: getErrorMessage(err),
      executionLog,
      startedAt,
      completedAt,
    });

    error(`Task "${task.name}" error: ${getErrorMessage(err)}`);
    return false;
  }
}

/**
 * Run all pending tasks from .takt/tasks/
 *
 * タスクを動的に取得する。各タスク実行前に次のタスクを取得するため、
 * 実行中にタスクファイルが追加・削除されても反映される。
 */
export async function runAllTasks(
  cwd: string,
  workflowName: string = DEFAULT_WORKFLOW_NAME,
  options?: TaskExecutionOptions,
): Promise<void> {
  const taskRunner = new TaskRunner(cwd);

  // 最初のタスクを取得
  let task = taskRunner.getNextTask();

  if (!task) {
    info('No pending tasks in .takt/tasks/');
    info('Create task files as .takt/tasks/*.yaml or use takt add');
    return;
  }

  header('Running tasks');

  let successCount = 0;
  let failCount = 0;

  while (task) {
    blankLine();
    info(`=== Task: ${task.name} ===`);
    blankLine();

    const taskSuccess = await executeAndCompleteTask(task, taskRunner, cwd, workflowName, options);

    if (taskSuccess) {
      successCount++;
    } else {
      failCount++;
    }

    // 次のタスクを動的に取得（新しく追加されたタスクも含む）
    task = taskRunner.getNextTask();
  }

  const totalCount = successCount + failCount;
  blankLine();
  header('Tasks Summary');
  status('Total', String(totalCount));
  status('Success', String(successCount), successCount === totalCount ? 'green' : undefined);
  if (failCount > 0) {
    status('Failed', String(failCount), 'red');
  }
}

/**
 * Resolve execution directory and workflow from task data.
 * If the task has worktree settings, create a shared clone and use it as cwd.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  defaultWorkflow: string
): Promise<{ execCwd: string; execWorkflow: string; isWorktree: boolean; branch?: string }> {
  const data = task.data;

  // No structured data: use defaults
  if (!data) {
    return { execCwd: defaultCwd, execWorkflow: defaultWorkflow, isWorktree: false };
  }

  let execCwd = defaultCwd;
  let isWorktree = false;
  let branch: string | undefined;

  // Handle worktree (now creates a shared clone)
  if (data.worktree) {
    // Summarize task content to English slug using AI
    info('Generating branch name...');
    const taskSlug = await summarizeTaskName(task.content, { cwd: defaultCwd });

    const result = createSharedClone(defaultCwd, {
      worktree: data.worktree,
      branch: data.branch,
      taskSlug,
      issueNumber: data.issue,
    });
    execCwd = result.path;
    branch = result.branch;
    isWorktree = true;
    info(`Clone created: ${result.path} (branch: ${result.branch})`);
  }

  // Handle workflow override
  const execWorkflow = data.workflow || defaultWorkflow;

  return { execCwd, execWorkflow, isWorktree, branch };
}
