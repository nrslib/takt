import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord, TasksFileData } from '../infra/task/schema.js';

const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: inspect,
}));

beforeEach(() => {
  vi.resetModules();
  inspect.mockReset().mockReturnValue('Mon Oct  5 12:00:00 2026\n');
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

describe('interrupted task recovery outside the update lock', () => {
  const birthTime = 'Mon Oct  5 12:00:00 2026';
  let state: TasksFileData;
  let store: import('../infra/task/store.js').TaskStore;
  let lifecycle: import('../infra/task/taskLifecycleService.js').TaskLifecycleService;

  beforeEach(async () => {
    const { TaskStore } = await import('../infra/task/store.js');
    const { TaskLifecycleService } = await import('../infra/task/taskLifecycleService.js');
    const { TaskRecordSchema, TasksFileSchema } = await import('../infra/task/schema.js');
    state = { tasks: [TaskRecordSchema.parse({
      name: 'task-a', content: 'Task', status: 'running', owner_pid: 12345,
      owner_start_time: birthTime, created_at: '2026-10-06T00:00:00Z',
      started_at: '2026-10-06T00:00:00Z', completed_at: null,
    })] };
    store = new TaskStore('/project');
    vi.spyOn(store, 'read').mockImplementation(() => structuredClone(state));
    vi.spyOn(store, 'update').mockImplementation((mutator) => {
      const next = mutator(state);
      if (next !== undefined) state = TasksFileSchema.parse(next);
      return state;
    });
    lifecycle = new TaskLifecycleService('/project', store.getTasksFilePath(), store);
  });

  it('does not update when every owner is alive with the recorded birth time', () => {
    const before = structuredClone(state);
    const onRecovered = vi.fn();

    expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(0);

    expect(store.read).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(store.update).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('checks owners before updating and notifies only after saving the recovered task', () => {
    inspect.mockReturnValue('different birth time');
    const update = vi.mocked(store.update).getMockImplementation()!;
    let inUpdate = false;
    vi.mocked(store.update).mockImplementationOnce((mutator) => {
      expect(inspect).toHaveBeenCalledTimes(1);
      inUpdate = true;
      try { return update(mutator); }
      finally { inUpdate = false; }
    });
    inspect.mockImplementation(() => {
      expect(inUpdate).toBe(false);
      return 'different birth time';
    });
    vi.mocked(process.kill).mockImplementation(() => {
      expect(inUpdate).toBe(false);
      return true;
    });
    const onRecovered = vi.fn(() => {
      expect(inUpdate).toBe(false);
      expect(state.tasks[0]?.status).toBe('failed');
    });

    expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(1);

    expect(store.update).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(state.tasks[0]).toMatchObject({ status: 'failed', owner_pid: null, owner_start_time: null,
      failure: { error: expect.stringContaining('interrupted') }, completed_at: expect.any(String) });
    expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'task-a', status: 'failed' }));
  });

  it.each(['status', 'owner_pid', 'owner_start_time'] as const)('preserves a concurrent change to %s', (field) => {
    const original = state.tasks[0]!;
    if (field === 'status') {
      state = { tasks: [{ ...original, owner_pid: null, owner_start_time: null }] };
    }
    inspect.mockReturnValue('different birth time');
    const onRecovered = vi.fn();
    let changed: TaskRecord;
    vi.mocked(store.update).mockImplementationOnce((mutator) => {
      const task = state.tasks[0]!;
      changed = field === 'status'
        ? { ...task, status: 'completed', completed_at: '2026-10-06T00:01:00Z' }
        : { ...task, [field]: field === 'owner_pid' ? 23456 : 'new owner birth time' };
      state = { tasks: [changed] };
      expect(mutator(state)).toBeUndefined();
      return state;
    });

    expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(0);

    expect(store.update).toHaveBeenCalledOnce();
    expect(state.tasks).toEqual([changed!]);
    expect(state.tasks[0]?.status).toBe(field === 'status' ? 'completed' : 'running');
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it.each(['goalTasksOnly', 'goalId'] as const)('inspects and recovers only the scope selected by %s', async (scope) => {
    const { TaskLifecycleService } = await import('../infra/task/taskLifecycleService.js');
    const goalId = '650e8400-e29b-41d4-a716-446655440000';
    const original = state.tasks[0]!;
    state = { tasks: [
      { ...original, goal_id: goalId },
      { ...original, name: 'ordinary', owner_pid: 23456 },
      { ...original, name: 'other-goal', owner_pid: 34567, goal_id: '650e8400-e29b-41d4-a716-446655440001' },
      { ...original, name: 'pending', status: 'pending', started_at: null, owner_pid: null, owner_start_time: null },
    ] };
    inspect.mockReturnValue('different birth time');
    lifecycle = new TaskLifecycleService('/project', store.getTasksFilePath(), store, undefined, scope === 'goalTasksOnly');

    expect(lifecycle.failInterruptedRunningTasks(scope === 'goalId' ? goalId : undefined)).toBe(scope === 'goalId' ? 1 : 2);

    expect(inspect.mock.calls.map((call) => call[1])).toEqual(scope === 'goalId'
      ? [['-o', 'lstart=', '-p', '12345']]
      : [['-o', 'lstart=', '-p', '12345'], ['-o', 'lstart=', '-p', '34567']]);
    expect(state.tasks.map(({ status }) => status)).toEqual(scope === 'goalId'
      ? ['failed', 'running', 'running', 'pending'] : ['failed', 'running', 'failed', 'pending']);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ordinary task owner process identity', () => {
  it('normalizes the inspector locale and timezone', async () => {
    const { getTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    expect(getTaskProcessIdentity(12345)).toEqual({ startTime: 'Mon Oct  5 12:00:00 2026' });
    expect(inspect).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '12345'],
      expect.objectContaining({
        shell: false, timeout: 1_000,
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }),
      }));
  });

  it('keeps the existing central lock inspector and its cache separate', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    inspect.mockReturnValueOnce('Mon Oct  5 12:00:00 2026\n').mockReturnValueOnce('task identity');
    const { getSelfProcessIdentity } = await import('../infra/task/process.js');
    const { getSelfTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    const lockIdentity = { startTime: 'darwin-start-v2:1791201600' };
    expect(getSelfProcessIdentity()).toEqual(lockIdentity);
    expect(getSelfTaskProcessIdentity()).toEqual({ startTime: 'task identity' });
    expect(getSelfProcessIdentity()).toEqual(lockIdentity);
    expect(getSelfTaskProcessIdentity()).toEqual({ startTime: 'task identity' });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect.mock.calls[0]?.[0]).toBe('/bin/ps');
    expect(inspect.mock.calls[1]?.[0]).toBe('ps');
  });

  it('preserves a live owner with the same recorded birth time', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'Mon Oct  5 12:00:00 2026')).toBe(false);
  });

  it('recovers an interrupted task when the live PID has a different birth time', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'Thu Jan  1 00:00:00 1970')).toBe(true);
  });

  it('preserves a live legacy owner without a recorded identity', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['empty', 'error'])('preserves a live owner when inspection returns %s', async (result) => {
    if (result === 'empty') inspect.mockReturnValue('');
    else inspect.mockImplementation(() => { throw new Error('ps unavailable'); });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(false);
  });

  it('preserves a live owner on an unsupported platform', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('recovers a dead owner without inspecting its birth time', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('recovers an owner with no PID', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(undefined, 'stored birth')).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid inspector PID %s', async (pid) => {
    const { getTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    expect(getTaskProcessIdentity(pid)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
});
