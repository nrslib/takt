import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retirePendingPatrols } from '../features/daemonTurn/retirePatrols.js';
import { reconcileLostRun } from '../features/daemonTurn/reconcileLostRun.js';
import { TaskRecordSchema, TasksFileSchema, type TasksFileData } from '../infra/task/schema.js';
import type { WatchObservation } from '../core/daemon/events.js';
import type { SavedManagerEvent } from '../infra/goals/events.js';

const doubles = vi.hoisted(() => ({ events: vi.fn(), remove: vi.fn(), save: vi.fn(), update: vi.fn(), identity: vi.fn() }));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: doubles.events, deleteManagerEvent: doubles.remove, saveManagerEvent: doubles.save }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_path: string, action: () => unknown) => action() }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { update = doubles.update; } }));
vi.mock('../infra/task/taskProcessIdentity.js', () => ({ getTaskProcessIdentity: doubles.identity }));
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });
it('retires only pending patrol files without executing a model or deleting completion events', () => {
  const events: SavedManagerEvent[] = [
    { filePath: '/old', event: { kind: 'patrol', goalId: randomUUID(), createdAt: '2026-11-03T00:00:00.000Z' } },
    { filePath: '/new', event: { kind: 'registered', goalId: randomUUID(), createdAt: '2026-11-03T00:00:00.000Z' } },
  ];
  doubles.events.mockReturnValue(events);
  expect(retirePendingPatrols('/repository')).toBe(1);
  expect(doubles.remove).toHaveBeenCalledExactlyOnceWith(events[0]);
});
function lostRun() {
  const goalId = randomUUID();
  const task = TaskRecordSchema.parse({ name: 'task', status: 'running', content: 'work', goal_id: goalId,
    created_at: '2026-11-03T00:00:00.000Z', started_at: '2026-11-03T00:00:01.000Z', completed_at: null,
    owner_pid: 12345, owner_start_time: 'start', run_slug: 'run', execution_id: 'execution' });
  let state: TasksFileData = { tasks: [task] };
  doubles.update.mockImplementation((update: (value: TasksFileData) => TasksFileData | undefined) => {
    state = TasksFileSchema.parse(update(state) ?? state); return state;
  });
  const observation: Extract<WatchObservation, { kind: 'run_process_lost' }> = {
    kind: 'run_process_lost', targetId: 'target', generation: 'generation', observedAt: '2026-11-03T00:00:00.000Z', pid: 12345, startTime: 'start',
    task: { repositoryDirectory: '/repository', goalId, taskName: 'task', runSlug: 'run', executionId: 'execution' },
  };
  return { observation, get state() { return state; }, task };
}
it('rechecks process loss under the task lock and records one completion', () => {
  const f = lostRun(); vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  expect(reconcileLostRun(f.observation, new AbortController().signal)).toBe(true);
  expect(f.state.tasks[0]).toMatchObject({ status: 'failed', owner_pid: null, owner_start_time: null, completion: { interrupted: true } });
  expect(reconcileLostRun(f.observation, new AbortController().signal)).toBe(false);
  expect(doubles.save).toHaveBeenCalledOnce();
});
it.each(['EPERM', 'alive', 'unknown'])('does not classify %s as a dead process', (mode) => {
  const f = lostRun();
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (mode === 'EPERM') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return true;
  });
  doubles.identity.mockReturnValue(mode === 'alive' ? { startTime: 'start' } : undefined);
  expect(reconcileLostRun(f.observation, new AbortController().signal)).toBe(false);
  expect(f.state.tasks[0]?.status).toBe('running'); expect(doubles.save).not.toHaveBeenCalled();
});
it('preserves a newer task generation and normal completion', () => {
  const f = lostRun(); vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  f.observation.task.executionId = 'old-execution';
  expect(reconcileLostRun(f.observation, new AbortController().signal)).toBe(false);
  f.observation.task.executionId = 'execution';
  doubles.update.mockImplementation((update: (value: TasksFileData) => TasksFileData | undefined) => update(TasksFileSchema.parse({ tasks: [
    { ...f.task, status: 'completed', completed_at: '2026-11-03T00:00:02.000Z', owner_pid: null, owner_start_time: null },
  ] })));
  expect(reconcileLostRun(f.observation, new AbortController().signal)).toBe(false);
  expect(doubles.save).not.toHaveBeenCalled();
});
