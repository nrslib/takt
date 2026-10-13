import type { TaskRecord, TaskStatus } from './schema.js';

export type ActiveTaskTarget =
  | { kind: 'pr'; value: number }
  | { kind: 'issue'; value: number }
  | { kind: 'branch'; value: string };

export class ActiveTaskTargetConflictError extends Error {
  constructor(
    readonly target: ActiveTaskTarget,
    readonly existingTaskName: string,
    readonly existingTaskStatus: 'pending' | 'running',
  ) {
    super(
      `Active task target already exists: ${target.kind}=${String(target.value)} `
      + `(${existingTaskName}, ${existingTaskStatus})`,
    );
    this.name = 'ActiveTaskTargetConflictError';
  }
}

function isActiveStatus(status: TaskStatus): status is 'pending' | 'running' {
  return status === 'pending' || status === 'running';
}

type TargetTask = Pick<TaskRecord, 'pr_number' | 'issue' | 'branch' | 'merge_task' | 'merge_head_repository_url'>;

function candidateTargets(candidate: TargetTask): ActiveTaskTarget[] {
  return [
    ...(candidate.pr_number !== undefined ? [{ kind: 'pr' as const, value: candidate.pr_number }] : []),
    ...(candidate.issue !== undefined ? [{ kind: 'issue' as const, value: candidate.issue }] : []),
    ...(candidate.branch !== undefined ? [{ kind: 'branch' as const, value: candidate.branch }] : []),
  ];
}

function matchesTarget(task: TaskRecord, target: ActiveTaskTarget): boolean {
  switch (target.kind) {
    case 'pr':
      return task.pr_number === target.value;
    case 'issue':
      return task.issue === target.value;
    case 'branch':
      return task.branch === target.value;
  }
}

export function findActiveTaskTargetConflict(
  tasks: TaskRecord[],
  candidate: TargetTask,
): ActiveTaskTargetConflictError | undefined {
  for (const target of candidateTargets(candidate)) {
    const existing = tasks.find((task) => isActiveStatus(task.status) && matchesTarget(task, target)
      && !(target.kind === 'branch' && task.merge_task === true && candidate.merge_task === true
        && task.merge_head_repository_url !== candidate.merge_head_repository_url));
    if (existing && isActiveStatus(existing.status)) {
      return new ActiveTaskTargetConflictError(target, existing.name, existing.status);
    }
  }
  return undefined;
}
