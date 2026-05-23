import {
  loadWorkflowByIdentifier,
  isWorkflowPath,
} from '../../../infra/config/index.js';
import { confirm } from '../../../shared/prompt/index.js';
import { createSharedClone, summarizeTaskName, resolveBaseBranch, TaskRunner } from '../../../infra/task/index.js';
import { info, error, warn, withProgress } from '../../../shared/ui/index.js';
import { statusLine } from '../../../shared/ui/StatusLine.js';
import { createLogger } from '../../../shared/utils/index.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeTask } from './taskExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectWorkflow } from '../../workflowSelection/index.js';
import { buildBooleanTaskResult, persistTaskError, persistTaskResult } from './taskResultHandler.js';
import { prepareTaskSpecDirectory, cleanupPreparedTaskSpec } from '../attachments.js';
import { cleanupStagedTaskSpec, stageTaskSpecForExecution, type StagedTaskSpec } from './taskSpecContext.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

function cleanupTransientTaskSpecs(
  preparedSpecTaskDir: string | undefined,
  stagedSpec: StagedTaskSpec | undefined,
): void {
  try {
    if (stagedSpec) {
      cleanupStagedTaskSpec(stagedSpec);
    }
  } finally {
    if (preparedSpecTaskDir) {
      cleanupPreparedTaskSpec(preparedSpecTaskDir);
    }
  }
}

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
  let preparedSpec: ReturnType<typeof prepareTaskSpecDirectory> | undefined;
  let stagedSpec: StagedTaskSpec | undefined;
  let reportDirName: string | undefined;
  try {
    preparedSpec = options?.attachments && options.attachments.length > 0
      ? prepareTaskSpecDirectory(cwd, task, options.attachments)
      : undefined;
    if (preparedSpec) {
      reportDirName = generateExecutionReportDir(execCwd, task);
      stagedSpec = stageTaskSpecForExecution(cwd, execCwd, preparedSpec.taskDirRelative, reportDirName);
    }
  } catch (error) {
    if (preparedSpec) {
      cleanupPreparedTaskSpec(preparedSpec.taskDir);
    }
    throw error;
  }
  if (options?.skipTaskList !== true) {
    try {
      taskRecord = taskRunner.addTask(task, {
        workflow: workflowIdentifier,
        ...(preparedSpec ? { task_dir: preparedSpec.taskDirRelative } : {}),
      });
    } catch (error) {
      cleanupTransientTaskSpecs(preparedSpec?.taskDir, stagedSpec);
      throw error;
    }
  }
  const preparedSpecTaskDirToCleanup = options?.skipTaskList === true ? preparedSpec?.taskDir : undefined;
  const stagedSpecToCleanup = options?.skipTaskList === true ? stagedSpec : undefined;
  const startedAt = new Date().toISOString();

  statusLine.start('Running...');
  let taskSuccess: boolean;
  try {
    taskSuccess = await executeTask({
      task: stagedSpec?.taskPrompt ?? task,
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: cwd,
      agentOverrides,
      interactiveUserInput: options?.interactiveUserInput === true,
      interactiveMetadata: options?.interactiveMetadata,
      ...(reportDirName ? { reportDirName } : {}),
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
    cleanupTransientTaskSpecs(preparedSpecTaskDirToCleanup, stagedSpecToCleanup);
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
