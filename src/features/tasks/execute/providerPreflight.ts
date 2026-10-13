import { confirm } from '../../../shared/prompt/index.js';
import { loadWorkflowByIdentifier, resolveProviderOptionsWithTrace, resolveConfigValues, resolveNonWorkflowProviderModel } from '../../../infra/config/index.js';
import { checkWorkflowProviders, type WorkflowProviderPreparationOptions } from '../../../infra/config/runtime-provider/execution-preparation.js';
import { checkManagedProviders, type ConfirmManagedProvider } from '../../../infra/managed-providers/preflight.js';
import type { TaskInfo, TaskListItem, TaskRunner } from '../../../infra/task/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../../shared/constants.js';
import { assertPrMergeRetryWorktreePath, resolveReusedWorktreeExecution, toReusedTaskInfo, type ReusedTaskPreparationOverride } from './reusedWorktree.js';

export function terminalProviderConfirmation(): ConfirmManagedProvider | undefined {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI && process.env.TAKT_NO_TTY !== '1'
    ? (message) => confirm(message, false) : undefined;
}

export async function checkTaskProviders(cwd: string, identifier: string, options: WorkflowProviderPreparationOptions, confirmation: ConfirmManagedProvider | undefined, signal?: AbortSignal, executionCwd = cwd): Promise<void> {
  const workflow = loadWorkflowByIdentifier(identifier, cwd, { lookupCwd: executionCwd });
  if (workflow === null) throw new Error(`Workflow not found: ${identifier}`);
  const providerOptions = resolveProviderOptionsWithTrace(cwd);
  await checkWorkflowProviders(cwd, executionCwd, workflow, {
    ...options, providerOptions: providerOptions.value,
    providerOptionsSource: providerOptions.source, providerOptionsOriginResolver: providerOptions.originResolver,
    selectorProviderOverrides: options.selectorProviderOverrides ?? {
      provider: options.provider, model: options.model,
      providerSource: options.providerSource, modelSource: options.modelSource,
    },
  }, confirmation, signal);
}

export async function checkTaskNameProvider(cwd: string, confirmation: ConfirmManagedProvider | undefined, signal?: AbortSignal): Promise<void> {
  if (resolveConfigValues(cwd, ['branchNameStrategy']).branchNameStrategy === 'ai') {
    const naming = resolveNonWorkflowProviderModel(cwd);
    if (naming.provider !== undefined) await checkManagedProviders([naming.provider], confirmation, signal);
  }
}

export async function checkQueuedTaskProviders(cwd: string, task: TaskInfo | TaskListItem, options: WorkflowProviderPreparationOptions, confirmation: ConfirmManagedProvider | undefined, signal?: AbortSignal, preparation?: ReusedTaskPreparationOverride): Promise<void> {
  const executionTask = toReusedTaskInfo(task, preparation);
  const unpreparedMergeClone = executionTask.data?.worktree && executionTask.data.merge_task === true
    && executionTask.data.merge_clone_prepared === false;
  if (unpreparedMergeClone) {
    if (!executionTask.worktreePath) throw new Error(`Worktree path is not set for task: ${executionTask.name}`);
    assertPrMergeRetryWorktreePath(cwd, executionTask.worktreePath, false);
  }
  const reused = executionTask.data?.worktree && !unpreparedMergeClone
    ? resolveReusedWorktreeExecution(cwd, executionTask) : undefined;
  await checkTaskProviders(cwd, executionTask.data?.workflow ?? DEFAULT_WORKFLOW_NAME, options, confirmation, signal, reused?.execCwd);
  if (executionTask.data?.worktree && executionTask.slug == null && reused === undefined) {
    await checkTaskNameProvider(cwd, confirmation, signal);
  }
}

export async function checkPendingTaskProviders(taskRunner: TaskRunner, cwd: string, options: WorkflowProviderPreparationOptions, confirmation: ConfirmManagedProvider | undefined, checkedTasks: readonly TaskInfo[], signal?: AbortSignal, goalTasksOnly = false): Promise<void> {
  const checked = new Map(checkedTasks.map((task) => [task.name, JSON.stringify(task)]));
  while (true) {
    signal?.throwIfAborted();
    const pending = taskRunner.listTasksForProviderPreflight(goalTasksOnly);
    const unchecked = pending.filter((task) => checked.get(task.name) !== JSON.stringify(task));
    if (unchecked.length === 0) return;
    for (const task of unchecked) {
      await checkQueuedTaskProviders(cwd, task, options, confirmation, signal);
      signal?.throwIfAborted();
      checked.set(task.name, JSON.stringify(task));
    }
  }
}
