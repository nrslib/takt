import type { PoolAssignment, PoolProject, PoolTask, PoolWorker } from './types.js';

export function workerPoolAvailability(task: PoolTask, project: PoolProject, workers: readonly PoolWorker[],
  assignments: readonly PoolAssignment[]): { worker?: PoolWorker; reason?: string } {
  const eligible = workers.filter((worker) => (!task.mergeTask || worker.kind === 'builtin')
    && (worker.kind === 'builtin' || task.origin !== undefined)
    && (worker.concurrency === undefined && worker.kind === 'builtin' || (worker.concurrency ?? 0) > 0));
  if (eligible.length === 0) return { reason: 'No executable worker is available: worker concurrency is 0' };
  if (assignments.filter((entry) => entry.projectId === project.projectId).length >= project.concurrency) {
    return { reason: 'Waiting for an available worker slot: project concurrency limit reached' };
  }
  const worker = eligible.find((entry) => entry.concurrency === undefined
    || assignments.filter((active) => active.workerName === entry.name).length < entry.concurrency);
  return worker === undefined ? { reason: 'Waiting for an available worker slot' } : { worker };
}

export function scheduleWorkerPool(input: {
  workers: readonly PoolWorker[];
  projects: readonly PoolProject[];
  pendingTasks: readonly PoolTask[];
  activeAssignments: readonly PoolAssignment[];
}): PoolAssignment[] {
  const selected: PoolAssignment[] = [];
  for (const task of input.pendingTasks) {
    const assignments = [...input.activeAssignments, ...selected];
    if (assignments.some((entry) => entry.projectId === task.projectId && entry.taskName === task.taskName)) continue;
    const project = input.projects.find((entry) => entry.projectId === task.projectId);
    if (project === undefined) throw new Error(`Unknown worker pool project: ${task.projectId}`);
    const { worker } = workerPoolAvailability(task, project, input.workers, assignments);
    if (worker !== undefined) selected.push({ projectId: task.projectId, taskName: task.taskName, workerName: worker.name });
  }
  return selected;
}
