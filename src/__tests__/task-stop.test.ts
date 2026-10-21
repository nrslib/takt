import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTaskStopHandled, TaskStoppedError } from '../infra/task/taskStop.js';
import { buildClaimedTaskRecord, buildRetryTaskRecord } from '../infra/task/taskRecordMutations.js';
import { TaskRecordSchema, TasksFileSchema, type TaskRecord, type TasksFileData } from '../infra/task/schema.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import type { TaskStore } from '../infra/task/store.js';
import * as taskProcess from '../infra/task/process.js';
import * as taskProcessIdentity from '../infra/task/taskProcessIdentity.js';
import { goalId } from './helpers/goal-fixtures.js';

const pending = () => TaskRecordSchema.parse({ name: 'task-a', content: 'work', status: 'pending',
  created_at: '2026-10-21T00:00:00.000Z', started_at: null, completed_at: null });

describe('task stop at the terminal persistence boundary', () => {
  it('permits ordinary completion without a matching request', () => {
    const task = buildClaimedTaskRecord(pending());
    expect(() => assertTaskStopHandled(task)).not.toThrow();
    expect(() => assertTaskStopHandled({ ...task,
      stop_request: { execution_id: 'older', requested_at: task.started_at! } })).not.toThrow();
  });

  it('rejects a result that would lose an accepted stop and accepts the stopped failure', () => {
    const task = buildClaimedTaskRecord(pending());
    const requested = { ...task, stop_request: { execution_id: task.execution_id!, requested_at: task.started_at! } };
    const error = new TaskStoppedError(task.name, task.execution_id!);
    for (const completion of [undefined, { success: true, interrupted: false },
      { success: false, interrupted: true, failureReason: 'Workflow interrupted' }]) {
      expect(() => assertTaskStopHandled(requested, completion)).toThrow(error.message);
    }
    expect(() => assertTaskStopHandled(requested, {
      success: false, interrupted: true, failureReason: error.message,
    })).not.toThrow();
  });

  it('gives each claim and direct retry a new identity and clears previous requests', () => {
    const task = buildClaimedTaskRecord(pending());
    const stopped = { ...task, stop_request: { execution_id: task.execution_id!, requested_at: task.started_at! } };
    const queued = buildRetryTaskRecord(stopped, 'pending', {});
    expect(queued.execution_id).toBeUndefined();
    expect(queued.stop_request).toBeUndefined();
    for (const next of [buildClaimedTaskRecord(queued), buildRetryTaskRecord(stopped, 'running', {})]) {
      expect(next.execution_id).toEqual(expect.any(String));
      expect(next.execution_id).not.toBe(task.execution_id);
      expect(next.stop_request).toBeUndefined();
    }
  });
});

describe('TaskLifecycleService.requestTaskStop', () => {
  const identity = { startTime: 'Mon Oct  5 12:00:00 2026' };

  beforeEach(() => {
    vi.spyOn(taskProcess, 'isProcessAlive').mockReturnValue(true);
    vi.spyOn(taskProcessIdentity, 'getSelfTaskProcessIdentity').mockReturnValue(identity);
    vi.spyOn(taskProcessIdentity, 'getTaskProcessIdentity').mockReturnValue(identity);
  });
  afterEach(() => vi.restoreAllMocks());

  function setup(task: TaskRecord) {
    let state: TasksFileData = { tasks: [task] };
    let writes = 0;
    const store = { update: (mutate: (current: TasksFileData) => TasksFileData | undefined) => {
      const next = mutate(structuredClone(state));
      if (next !== undefined) { state = TasksFileSchema.parse(next); writes++; }
      return state;
    } } as TaskStore;
    return { service: new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store),
      state: () => state, writes: () => writes };
  }

  it('saves only the request, preserves ownership and running status, and reuses duplicate requests', () => {
    const task = buildClaimedTaskRecord({ ...pending(), goal_id: goalId });
    const fixture = setup(task);
    const request = fixture.service.requestTaskStop(goalId, task.name, task.execution_id!);
    expect(request).toMatchObject({ execution_id: task.execution_id, requested_at: expect.any(String) });
    expect(fixture.state().tasks[0]).toEqual({ ...task, stop_request: request });
    expect(fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toEqual(request);
    expect(fixture.writes()).toBe(1);
  });

  it.each([null, undefined])('accepts a live PID without a saved owner start time (%s) and reuses its request', (ownerStartTime) => {
    const task = buildClaimedTaskRecord({ ...pending(), goal_id: goalId });
    const saved = { ...task, owner_start_time: ownerStartTime };
    const fixture = setup(saved);
    vi.mocked(taskProcessIdentity.getTaskProcessIdentity).mockReturnValue(undefined);

    const request = fixture.service.requestTaskStop(goalId, task.name, task.execution_id!);
    expect(request).toMatchObject({ execution_id: task.execution_id, requested_at: expect.any(String) });
    expect(fixture.state().tasks[0]).toEqual({ ...saved, stop_request: request });
    expect(fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toEqual(request);
    expect(fixture.writes()).toBe(1);

    const before = structuredClone(fixture.state());
    vi.mocked(taskProcess.isProcessAlive).mockReturnValue(false);
    expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toThrow(/not alive/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(1);
  });

  it.each([null, identity.startTime])('rejects a dead owner with saved start time %s without a write', (ownerStartTime) => {
    const task = { ...buildClaimedTaskRecord({ ...pending(), goal_id: goalId }), owner_start_time: ownerStartTime };
    const fixture = setup(task);
    const before = structuredClone(fixture.state());
    vi.mocked(taskProcess.isProcessAlive).mockReturnValue(false);

    expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toThrow(/not alive/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(0);
  });

  it('rejects a known owner start time mismatch without a write', () => {
    const task = buildClaimedTaskRecord({ ...pending(), goal_id: goalId });
    const fixture = setup(task);
    const before = structuredClone(fixture.state());
    vi.mocked(taskProcessIdentity.getTaskProcessIdentity).mockReturnValue({ startTime: 'different birth' });

    expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toThrow(/no longer matches/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(0);
  });

  it.each(['goal', 'name', 'execution'] as const)('rejects a mismatched %s without a saved start time', (condition) => {
    const task = { ...buildClaimedTaskRecord({ ...pending(), goal_id: goalId }), owner_start_time: null };
    const fixture = setup(task);
    const before = structuredClone(fixture.state());

    expect(() => fixture.service.requestTaskStop(condition === 'goal' ? 'other-goal' : goalId,
      condition === 'name' ? 'other-name' : task.name,
      condition === 'execution' ? 'other-execution' : task.execution_id!)).toThrow(/goal|name|execution/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(0);
  });

  it('rejects an unavailable current owner identity without a write', () => {
    const task = buildClaimedTaskRecord({ ...pending(), goal_id: goalId });
    const fixture = setup(task);
    const before = structuredClone(fixture.state());
    vi.mocked(taskProcessIdentity.getTaskProcessIdentity).mockReturnValue(undefined);

    expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!))
      .toThrow(/cannot verify.*owner/i);
    expect(fixture.writes()).toBe(0);
    expect(fixture.state()).toEqual(before);
  });

  it.each(['goal', 'name', 'execution', 'pending', 'ended owner'] as const)(
    'rejects a mismatched %s without a write', (condition) => {
      const task = condition === 'pending' ? { ...pending(), goal_id: goalId, execution_id: 'old-run' }
        : buildClaimedTaskRecord({ ...pending(), goal_id: goalId });
      const fixture = setup(condition === 'ended owner' ? { ...task, owner_pid: null, owner_start_time: null } : task);
      const before = structuredClone(fixture.state());
      expect(() => fixture.service.requestTaskStop(condition === 'goal' ? 'other-goal' : goalId,
        condition === 'name' ? 'other-name' : task.name,
        condition === 'execution' ? 'other-execution' : task.execution_id!)).toThrow();
      expect(fixture.state()).toEqual(before);
      expect(fixture.writes()).toBe(0);
    });

  it.each(['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const)(
    'rejects a task in %s status without a write', (status) => {
      const task = { ...buildClaimedTaskRecord({ ...pending(), goal_id: goalId }), status };
      const fixture = setup(task);
      const before = structuredClone(fixture.state());
      expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toThrow(/not running/i);
      expect(fixture.state()).toEqual(before);
      expect(fixture.writes()).toBe(0);
    });

  it('rejects a saved duplicate request after its execution has ended', () => {
    const task = { ...buildClaimedTaskRecord({ ...pending(), goal_id: goalId }), owner_start_time: null };
    const fixture = setup(task);
    fixture.service.requestTaskStop(goalId, task.name, task.execution_id!);
    Object.assign(fixture.state().tasks[0]!, { status: 'failed', completed_at: task.started_at,
      owner_pid: null, failure: { error: 'execution ended' } });
    const before = structuredClone(fixture.state());

    expect(() => fixture.service.requestTaskStop(goalId, task.name, task.execution_id!)).toThrow(/not running/i);
    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(1);
  });
});
