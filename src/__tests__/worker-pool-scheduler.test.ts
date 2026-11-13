import { describe, expect, it } from 'vitest';
import { scheduleWorkerPool } from '../core/worker-pool/scheduler.js';

function pendingTasks(projectId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    projectId, taskName: `${projectId}-${index}`, mergeTask: false, origin: 'https://example.com/team/repository.git',
  }));
}

describe('worker pool scheduling', () => {
  it.each([
    { workerCount: 1, workerConcurrency: 1, projectConcurrency: 3, expected: 1 },
    { workerCount: 2, workerConcurrency: 1, projectConcurrency: 3, expected: 2 },
    { workerCount: 2, workerConcurrency: 1, projectConcurrency: 1, expected: 1 },
    { workerCount: 1, workerConcurrency: 2, projectConcurrency: 3, expected: 2 },
  ])('respects both limits and refills one released slot: %j', (scenario) => {
    const workers = Array.from({ length: scenario.workerCount }, (_, index) => ({
      name: `worker-${index}`, kind: 'remote' as const, concurrency: scenario.workerConcurrency,
    }));
    const projects = [{ projectId: 'R1', concurrency: scenario.projectConcurrency }];
    const tasks = pendingTasks('R1', 3);
    const first = scheduleWorkerPool({ workers, projects, pendingTasks: tasks, activeAssignments: [] });

    expect(first).toHaveLength(scenario.expected);
    expect(new Set(first.map((entry) => entry.taskName)).size).toBe(scenario.expected);
    expect(first.every((entry) => entry.projectId === 'R1')).toBe(true);
    for (const assignment of first) {
      expect(workers.map((worker) => worker.name)).toContain(assignment.workerName);
    }
    for (const worker of workers) {
      expect(first.filter((entry) => entry.workerName === worker.name).length)
        .toBeLessThanOrEqual(worker.concurrency);
    }
    const waiting = tasks.filter((task) => !first.some((entry) => entry.taskName === task.taskName));
    expect(waiting).toHaveLength(3 - scenario.expected);
    expect(scheduleWorkerPool({ workers, projects, pendingTasks: waiting, activeAssignments: first })).toEqual([]);

    const remaining = first.slice(1);
    const next = scheduleWorkerPool({ workers, projects, pendingTasks: waiting, activeAssignments: remaining });
    expect(next).toHaveLength(1);
    expect(waiting.map((task) => task.taskName)).toContain(next[0]!.taskName);
    expect(remaining.length + next.length).toBe(scenario.expected);
    for (const worker of workers) {
      expect([...remaining, ...next].filter((entry) => entry.workerName === worker.name).length)
        .toBeLessThanOrEqual(worker.concurrency);
    }
  });

  it('shares one worker across repositories while respecting each project limit', () => {
    const workers = [{ name: 'w1', kind: 'remote' as const, concurrency: 2 }];
    const projects = [{ projectId: 'R1', concurrency: 1 }, { projectId: 'R2', concurrency: 1 }];
    const tasks = [...pendingTasks('R1', 2), ...pendingTasks('R2', 2)];
    const first = scheduleWorkerPool({ workers, projects, pendingTasks: tasks, activeAssignments: [] });

    expect(first).toHaveLength(2);
    expect(first.map((entry) => entry.projectId).sort()).toEqual(['R1', 'R2']);
    expect(first.every((entry) => entry.workerName === 'w1')).toBe(true);
    const waiting = tasks.filter((task) => !first.some((entry) => entry.taskName === task.taskName));
    expect(scheduleWorkerPool({ workers, projects, pendingTasks: waiting, activeAssignments: first })).toEqual([]);

    const active = first.filter((entry) => entry.projectId === 'R2');
    const next = scheduleWorkerPool({ workers, projects, pendingTasks: waiting, activeAssignments: active });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ projectId: 'R1', workerName: 'w1' });
    expect(waiting.filter((task) => task.projectId === 'R1').map((task) => task.taskName)).toContain(next[0]!.taskName);
  });

  it('uses project concurrency when builtin concurrency is omitted', () => {
    const assignments = scheduleWorkerPool({
      workers: [{ name: 'builtin', kind: 'builtin', concurrency: undefined }],
      projects: [{ projectId: 'R1', concurrency: 3 }],
      pendingTasks: pendingTasks('R1', 3), activeAssignments: [],
    });
    expect(assignments).toHaveLength(3);
    expect(assignments.every((entry) => entry.workerName === 'builtin')).toBe(true);
  });

  it('preserves different project limits when builtin concurrency is omitted', () => {
    const assignments = scheduleWorkerPool({
      workers: [{ name: 'builtin', kind: 'builtin', concurrency: undefined }],
      projects: [{ projectId: 'R1', concurrency: 1 }, { projectId: 'R2', concurrency: 3 }],
      pendingTasks: [...pendingTasks('R1', 2), ...pendingTasks('R2', 4)], activeAssignments: [],
    });
    expect(assignments.filter((entry) => entry.projectId === 'R1')).toHaveLength(1);
    expect(assignments.filter((entry) => entry.projectId === 'R2')).toHaveLength(3);
  });

  it('applies explicit builtin concurrency across all repositories', () => {
    const workers = [{ name: 'builtin', kind: 'builtin' as const, concurrency: 2 }];
    const projects = [{ projectId: 'R1', concurrency: 1 }, { projectId: 'R2', concurrency: 3 }];
    const activeAssignments = [{ projectId: 'R1', taskName: 'already-running', workerName: 'builtin' }];
    const assignments = scheduleWorkerPool({ workers, projects, activeAssignments,
      pendingTasks: [...pendingTasks('R1', 2), ...pendingTasks('R2', 3)],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ projectId: 'R2', workerName: 'builtin' });
  });

  it.each([false, true])('does not assign a task with mergeTask=%s when builtin concurrency is zero', (mergeTask) => {
    expect(scheduleWorkerPool({
      workers: [{ name: 'builtin', kind: 'builtin', concurrency: 0 }],
      projects: [{ projectId: 'R1', concurrency: 3 }],
      pendingTasks: [{ ...pendingTasks('R1', 1)[0]!, mergeTask }], activeAssignments: [],
    })).toEqual([]);
  });

  it('keeps PR merge tasks pending while an available fake remote worker accepts ordinary goal tasks', () => {
    const [merge, ordinary] = pendingTasks('R1', 2);
    const assignments = scheduleWorkerPool({
      workers: [{ name: 'builtin', kind: 'builtin', concurrency: 0 },
        { name: 'w1', kind: 'remote', concurrency: 2 }],
      projects: [{ projectId: 'R1', concurrency: 3 }],
      pendingTasks: [{ ...merge!, mergeTask: true }, ordinary!], activeAssignments: [],
    });
    expect(assignments).toEqual([{ projectId: 'R1', taskName: ordinary!.taskName, workerName: 'w1' }]);
  });

  it('routes PR merge work to builtin even when a remote worker is listed first', () => {
    expect(scheduleWorkerPool({
      workers: [{ name: 'w1', kind: 'remote', concurrency: 2 },
        { name: 'builtin', kind: 'builtin', concurrency: 1 }],
      projects: [{ projectId: 'R1', concurrency: 3 }],
      pendingTasks: [{ ...pendingTasks('R1', 1)[0]!, mergeTask: true }], activeAssignments: [],
    })).toEqual([{ projectId: 'R1', taskName: 'R1-0', workerName: 'builtin' }]);
  });

  it('leaves originless work pending while a remote worker accepts work with an origin', () => {
    const tasks = [
      { ...pendingTasks('local-only', 1)[0]!, origin: undefined },
      ...pendingTasks('shared', 1),
    ];
    expect(scheduleWorkerPool({
      workers: [{ name: 'builtin', kind: 'builtin', concurrency: 0 },
        { name: 'w1', kind: 'remote', concurrency: 2 }],
      projects: [{ projectId: 'local-only', concurrency: 2 }, { projectId: 'shared', concurrency: 2 }],
      pendingTasks: tasks, activeAssignments: [],
    })).toEqual([{ projectId: 'shared', taskName: 'shared-0', workerName: 'w1' }]);
  });

  it('routes originless work to builtin even when a remote worker has capacity and is listed first', () => {
    const tasks = [{ ...pendingTasks('R1', 1)[0]!, origin: undefined }];
    expect(scheduleWorkerPool({
      workers: [{ name: 'w1', kind: 'remote', concurrency: 2 },
        { name: 'builtin', kind: 'builtin', concurrency: 1 }],
      projects: [{ projectId: 'R1', concurrency: 2 }],
      pendingTasks: tasks, activeAssignments: [],
    })).toEqual([{ projectId: 'R1', taskName: 'R1-0', workerName: 'builtin' }]);
  });
});
