import type { PoolAssignment, PoolProject, PoolTask, PoolWorker } from './types.js';

export function workerPoolAvailability(task: PoolTask, project: PoolProject, workers: readonly PoolWorker[],
  assignments: readonly PoolAssignment[]): { worker?: PoolWorker; reason?: string } {
  const eligible = workers.filter((worker) => (!task.mergeTask || worker.kind === 'builtin')
    && (!task.remoteOnly || worker.kind === 'remote')
    && (task.retryWorker === undefined || task.retryWorker === worker.name && task.retryReady === true)
    && (worker.kind === 'builtin' || task.origin !== undefined)
    && (worker.concurrency === undefined && worker.kind === 'builtin' || (worker.concurrency ?? 0) > 0));
  if (eligible.length === 0) return { reason: 'No executable worker is available: worker concurrency is 0' };
  if (assignments.filter((entry) => entry.projectId === project.projectId && !entry.retryReservation).length >= project.concurrency) {
    return { reason: 'Waiting for an available worker slot: project concurrency limit reached' };
  }
  const worker = eligible.find((entry) => entry.concurrency === undefined
    || assignments.filter((active) => active.workerName === entry.name
      && (active.registrationGeneration === undefined || entry.registrationGeneration === undefined || active.registrationGeneration === entry.registrationGeneration)
      && !(active.retryReservation && active.projectId === task.projectId && active.taskName === task.taskName)).length < entry.concurrency);
  return worker === undefined ? { reason: 'Waiting for an available worker slot' } : { worker };
}

export function scheduleWorkerPool(input: {
  workers: readonly PoolWorker[];
  projects: readonly PoolProject[];
  pendingTasks: readonly PoolTask[];
  activeAssignments: readonly PoolAssignment[];
  requestedWorker?: string;
}): PoolAssignment[] {
  const selected: PoolAssignment[] = [];
  for (const task of [...input.pendingTasks].sort((a, b) => Number(b.remoteOnly || b.retryWorker !== undefined) - Number(a.remoteOnly || a.retryWorker !== undefined))) {
    const assignments = [...input.activeAssignments.filter((entry) => !entry.retryReservation || !selected.some((chosen) =>
      chosen.projectId === entry.projectId && chosen.taskName === entry.taskName)), ...selected];
    if (assignments.some((entry) => !entry.retryReservation && entry.projectId === task.projectId && entry.taskName === task.taskName)) continue;
    const project = input.projects.find((entry) => entry.projectId === task.projectId);
    if (project === undefined) throw new Error(`Unknown worker pool project: ${task.projectId}`);
    if (!task.remoteOnly && task.retryWorker === undefined && input.pendingTasks.some((retry) => retry.projectId === task.projectId
      && (retry.remoteOnly || retry.retryWorker !== undefined)
      && !assignments.some((entry) => !entry.retryReservation && entry.projectId === retry.projectId && entry.taskName === retry.taskName)
      && workerPoolAvailability({ ...retry, retryReady: true }, project, input.workers, assignments).worker !== undefined)) continue;
    const { worker } = workerPoolAvailability(task, project, input.workers.filter((worker) => input.requestedWorker === undefined || worker.name === input.requestedWorker), assignments);
    if (worker !== undefined) selected.push({ projectId: task.projectId, taskName: task.taskName, workerName: worker.name });
  }
  return selected;
}
