import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskStore } from '../infra/task/store.js';
import type { TaskRecord, TasksFileData } from '../infra/task/schema.js';
import { goalId } from './helpers/goal-fixtures.js';

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

async function setup(entry: 'claim' | 'retry', ownerPid: number) {
  const { buildClaimedTaskRecord, buildRetryTaskRecord } = await import('../infra/task/taskRecordMutations.js');
  const { TaskRecordSchema, TasksFileSchema } = await import('../infra/task/schema.js');
  const { TaskLifecycleService } = await import('../infra/task/taskLifecycleService.js');
  const pending = TaskRecordSchema.parse({ name: 'task-a', content: 'work', goal_id: goalId,
    status: 'pending', created_at: '2026-10-21T00:00:00.000Z', started_at: null, completed_at: null });
  const previous: TaskRecord = { ...pending, status: 'failed', execution_id: 'old-execution',
    stop_request: { execution_id: 'old-execution', requested_at: pending.created_at } };
  const task = entry === 'claim' ? buildClaimedTaskRecord(pending) : buildRetryTaskRecord(previous, 'running', {});
  let state: TasksFileData = TasksFileSchema.parse(JSON.parse(JSON.stringify({ tasks: [{ ...task, owner_pid: ownerPid }] })));
  let writes = 0;
  const store = { update: (mutate: (current: TasksFileData) => TasksFileData | undefined) => {
    const next = mutate(structuredClone(state));
    if (next !== undefined) { state = TasksFileSchema.parse(next); writes++; }
    return state;
  } } as TaskStore;
  return { task: state.tasks[0]!, state: () => structuredClone(state), writes: () => writes,
    service: new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store) };
}

describe.each(['claim', 'retry'] as const)('Windows %s owner identity and stop acceptance', (entry) => {
  it('restores an owner without a start time and accepts only the current execution', async () => {
    const fixture = await setup(entry, process.pid);
    const { task, service } = fixture;
    expect(task.owner_start_time).toBeNull();
    expect(task.execution_id).toEqual(expect.any(String));
    expect(task.execution_id).not.toBe('old-execution');
    expect(task.stop_request).toBeUndefined();
    const before = fixture.state();
    expect(() => service.requestTaskStop(goalId, task.name, 'old-execution')).toThrow(/execution/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(0);
    const request = service.requestTaskStop(goalId, task.name, task.execution_id!);
    expect(fixture.state().tasks[0]).toEqual({ ...task, stop_request: request });
    expect(fixture.writes()).toBe(1);
  });

  it.each([true, false])(
    'checks whether another owner PID is alive (%s) before saving', async (alive) => {
      const fixture = await setup(entry, process.pid + 1);
      expect(fixture.task.owner_start_time).toBeNull();
      if (!alive) vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
      });
      const before = fixture.state();
      const request = () => fixture.service.requestTaskStop(goalId, fixture.task.name, fixture.task.execution_id!);
      if (alive) {
        const accepted = request();
        expect(fixture.state().tasks[0]).toEqual({ ...fixture.task, stop_request: accepted });
        expect(fixture.writes()).toBe(1);
      } else {
        expect(request).toThrow(/not alive/i);
        expect(fixture.state()).toEqual(before);
        expect(fixture.writes()).toBe(0);
      }
    });
});
