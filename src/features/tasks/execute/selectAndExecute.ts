import {
  loadWorkflowByIdentifier,
  isWorkflowPath,
} from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { createSharedClone, summarizeTaskName, resolveBaseBranch, TaskRunner } from '../../../infra/task/index.js';
import { info, error, warn, withProgress } from '../../../shared/ui/index.js';
import { statusLine } from '../../../shared/ui/StatusLine.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeTask } from './taskExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectWorkflow } from '../../workflowSelection/index.js';
import { buildBooleanTaskResult, persistTaskError, persistTaskResult } from './taskResultHandler.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

export async function determineWorkflow(cwd: string, override?: string): Promise<string | null> {
  if (override) {
    if (isWorkflowPath(override)) {
      return override;
    }
    const resolvedWorkflow = loadWorkflowByIdentifier(override, cwd);
    if (!resolvedWorkflow) {
      error(`Workflow not found: ${sanitizeTerminalText(override)}`);
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
  branchOverride?: string,
  baseBranchOverride?: string,
): Promise<WorktreeConfirmationResult> {
  const useWorktree =
    typeof createWorktreeOverride === 'boolean'
      ? createWorktreeOverride
      : await confirm('Create worktree?', true);

  if (!useWorktree) {
    return { execCwd: cwd, isWorktree: false };
  }

  const baseBranch = resolveBaseBranch(cwd, baseBranchOverride).branch;

  const taskSlug = await withProgress(
    'Generating branch name...',
    (slug) => `Branch name generated: ${slug}`,
    () => summarizeTaskName(task, { cwd }),
  );

  const result = await withProgress(
    'Creating clone...',
    (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
        async () => createSharedClone(cwd, {
          worktree: true,
          taskSlug,
          ...(baseBranchOverride ? { baseBranch: baseBranchOverride } : {}),
          ...(branchOverride ? { branch: branchOverride } : {}),
        }),
      );

  return { execCwd: result.path, isWorktree: true, branch: result.branch, baseBranch, taskSlug };
}

export async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void> {
  const workflowIdentifier = await determineWorkflow(cwd, options?.workflow);

  if (workflowIdentifier === null) {
    info('Cancelled');
    return;
  }

  const execCwd = cwd;
  log.info('Starting task execution', { workflow: workflowIdentifier, worktree: false });
  const taskRunner = new TaskRunner(cwd, { onWarning: warn });
  let taskRecord: Awaited<ReturnType<TaskRunner['addTask']>> | null = null;
  if (options?.skipTaskList !== true) {
    taskRecord = taskRunner.addTask(task, {
      workflow: workflowIdentifier,
    });
  }
  const startedAt = new Date().toISOString();

  statusLine.start('Running...');
  let taskSuccess: boolean;
  try {
    taskSuccess = await executeTask({
      task,
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: cwd,
      agentOverrides,
      interactiveUserInput: options?.interactiveUserInput === true,
      interactiveMetadata: options?.interactiveMetadata,
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    if (taskRecord) {
      persistTaskError(taskRunner, taskRecord, startedAt, completedAt, err, {
        responsePrefix: 'Task failed: ',
      });
    }
    throw err;
  } finally {
    statusLine.stop();
  }

  const completedAt = new Date().toISOString();

  if (taskRecord) {
    const taskResult = buildBooleanTaskResult({
      task: taskRecord,
      taskSuccess,
      successResponse: 'Task completed successfully',
      failureResponse: 'Task failed',
      startedAt,
      completedAt,
    });
    persistTaskResult(taskRunner, taskResult);
  }

  if (!taskSuccess) {
    process.exit(1);
  }
}
