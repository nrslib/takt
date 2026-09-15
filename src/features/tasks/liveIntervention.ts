import { readRunMetaBySlug, type RunMeta } from '../../core/workflow/run/run-meta.js';
import { LiveInterventionFileStore } from '../../infra/workflow/live-intervention-store.js';
import { TaskRunner, type TaskState } from '../../infra/task/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { assertTaskStateWorktreeOwnership } from './taskStateWorktreeOwnership.js';

export interface TellableRunningTask {
  readonly task: TaskState;
  readonly runSlug: string;
  readonly worktreePath: string;
  readonly meta: RunMeta;
}

export interface TellableRunningTaskInspection {
  readonly tasks: readonly TellableRunningTask[];
  readonly excluded: readonly string[];
}

function isWorktreeTask(task: TaskState): boolean {
  return task.worktreePath !== undefined && task.worktree !== false;
}

function findTaskForRun(projectCwd: string, runSlug: string): TaskState {
  const task = new TaskRunner(projectCwd)
    .listTaskStateItems()
    .find((candidate) => candidate.runSlug === runSlug);
  if (task === undefined) {
    throw new Error(`Tell target run is missing from the task list: ${runSlug}`);
  }
  return task;
}

function resolveTellableTaskFromTask(
  projectCwd: string,
  task: TaskState,
  requestedRunSlug = task.runSlug,
): TellableRunningTask {
  const runSlug = requestedRunSlug ?? task.runSlug;
  if (runSlug === undefined) {
    throw new Error(`Tell target run is missing a run slug for task: ${task.name}`);
  }
  if (task.kind !== 'running') {
    throw new Error(`Tell target run is not running: ${runSlug} (task status is ${task.kind})`);
  }
  if (!isWorktreeTask(task)) {
    throw new Error(`Tell target run is not a worktree clone: ${runSlug}`);
  }
  const worktreePath = task.worktreePath!;
  try {
    assertTaskStateWorktreeOwnership(projectCwd, task);
  } catch (error) {
    throw new Error(`Tell target run is not a valid worktree clone: ${runSlug}`, { cause: error });
  }

  let meta: RunMeta | null;
  try {
    meta = readRunMetaBySlug(worktreePath, runSlug);
  } catch (error) {
    throw new Error(`Tell target run slug mismatch: ${runSlug}`, { cause: error });
  }
  if (meta === null) {
    throw new Error(`Tell target run is missing run metadata: ${runSlug}`);
  }
  if (meta.runSlug !== runSlug) {
    throw new Error(`Tell target run slug mismatch: requested ${runSlug}, metadata ${meta.runSlug}`);
  }
  if (meta.status !== 'running') {
    throw new Error(`Tell target run is not running: ${runSlug} (run status is ${meta.status})`);
  }
  return { task, runSlug, worktreePath, meta };
}

export function resolveTellableRunningTask(
  projectCwd: string,
  runSlug: string,
): TellableRunningTask {
  return resolveTellableTaskFromTask(projectCwd, findTaskForRun(projectCwd, runSlug), runSlug);
}

export function inspectTellableRunningTasks(projectCwd: string): TellableRunningTaskInspection {
  const tasks = new TaskRunner(projectCwd).listTaskStateItems();
  const result: TellableRunningTask[] = [];
  const excluded: string[] = [];
  for (const task of tasks) {
    if (task.kind !== 'running') {
      continue;
    }
    if (task.runSlug === undefined) {
      excluded.push(`${task.name}: missing run identity`);
      continue;
    }
    if (!isWorktreeTask(task)) {
      excluded.push(`${task.name}: not a worktree clone`);
      continue;
    }
    try {
      result.push(resolveTellableTaskFromTask(projectCwd, task));
    } catch (error) {
      // A task can finish or disappear while the selector is being built.
      // Re-resolve again at confirmation time; retain the reason for the selector.
      excluded.push(`${task.name}: ${getErrorMessage(error)}`);
    }
  }
  return { tasks: result, excluded };
}

/** Return only tasks that can receive an intervention. */
export function listTellableRunningTasks(projectCwd: string): TellableRunningTask[] {
  return [...inspectTellableRunningTasks(projectCwd).tasks];
}

export async function issueTellableRunningTask(
  projectCwd: string,
  runSlug: string,
  content: string,
): Promise<{ readonly instructionId: number; readonly target: TellableRunningTask }> {
  if (content.trim().length === 0) {
    throw new Error('Tell instruction content is required');
  }
  const target = resolveTellableRunningTask(projectCwd, runSlug);
  const store = new LiveInterventionFileStore(projectCwd, runSlug);
  const instructionId = await store.issue(content, undefined, () => {
    resolveTellableRunningTask(projectCwd, runSlug);
  });
  return { instructionId, target };
}
