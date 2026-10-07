import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagerRunState } from '../infra/task/manager-run-state.js';
const doubles = vi.hoisted(() => ({ config: vi.fn(), owner: vi.fn(), pending: vi.fn(), spawn: vi.fn(), exists: vi.fn(), open: vi.fn(), close: vi.fn(), childIdentity: vi.fn(), selfIdentity: vi.fn(), resolve: vi.fn(), recover: vi.fn() }));
let state: ManagerRunState;
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.pending() }; } } }));
vi.mock('../infra/task/mapper.js', () => ({ resolveTaskContent: doubles.resolve }));
vi.mock('../infra/task/project-execution-lock.js', () => ({ getProjectExecutionOwner: doubles.owner }));
vi.mock('../infra/goals/turn-lock.js', () => ({ GOAL_TURN_OWNERS_ENV: 'TAKT_MANAGER_GOAL_OWNERS' }));
vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: doubles.selfIdentity, getProcessIdentity: doubles.childIdentity }));
vi.mock('../infra/task/manager-run-state.js', () => ({
  MANAGER_RUN_TOKEN_ENV: 'TAKT_MANAGER_RUN_TOKEN',
  withProjectRunCoordination: (_cwd: string, action: () => unknown) => action(),
  recoverManagerReservation: doubles.recover, readManagerRunState: () => state,
  writeManagerRunState: (_cwd: string, next: ManagerRunState) => { state = next; },
  recordManagerRunFailure: (_cwd: string, error: Error) => { state.failures.push({ id: 'failure', message: error.message, at: 'now' }); },
  processRecord: (pid: number, identity: { startTime: string }) => ({ pid, startTime: identity.startTime }),
}));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: doubles.exists, openSync: doubles.open, closeSync: doubles.close }));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));
import { ensureManagerRun } from '../features/manager/autoRun.js';
beforeEach(() => {
  vi.resetAllMocks();
  state = { requested: true, failures: [] };
  doubles.recover.mockImplementation(() => state);
  doubles.config.mockReturnValue({ autoRun: true });
  doubles.selfIdentity.mockReturnValue({ startTime: 'parent' });
  doubles.pending.mockReturnValue([{ name: 'saved-task', status: 'pending', content: 'work' }]);
  doubles.exists.mockReturnValue(true);
  doubles.open.mockReturnValue(99);
  doubles.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn() });
    queueMicrotask(() => {
      state = { ...state, requested: false, reservation: { ...state.reservation!, adoptedOwnerId: 'adopted' } };
      child.emit('spawn');
    });
    return child;
  });
});
it('records an unavailable launcher identity without spawning or losing pending work', async () => {
  doubles.selfIdentity.mockReturnValue(undefined);
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(state.reservation).toBeUndefined();
  expect(state.failures).toEqual([expect.objectContaining({ message: expect.any(String) })]);
  expect(state.requested).toBe(true);
});
afterEach(() => vi.useRealTimers());
it('records child exit before ownership adoption and makes the pending task recoverable', async () => {
  doubles.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn() });
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1); });
    return child;
  });
  await ensureManagerRun('/project', 'turn-ended');
  expect(state.reservation).toBeUndefined();
  expect(state.failures).toEqual([expect.objectContaining({ message: expect.any(String) })]);
  expect(doubles.pending()).toHaveLength(1);
});
it('bounds adoption waiting and retains the child reservation when its identity cannot be checked', async () => {
  vi.useFakeTimers();
  doubles.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const starting = ensureManagerRun('/project', 'turn-ended');
  await vi.advanceTimersByTimeAsync(10025);
  await starting;
  expect(state.reservation?.child).toEqual({ pid: 42, startTime: undefined });
  expect(state.reservation?.adoptedOwnerId).toBeUndefined();
  expect(state.failures).toHaveLength(1);
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).toHaveBeenCalledTimes(1);
});
it('records child identity when Linux evidence becomes available before adoption', async () => {
  vi.useFakeTimers();
  doubles.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const starting = ensureManagerRun('/project', 'turn-ended');
  await vi.advanceTimersByTimeAsync(25);
  expect(state.reservation?.child).toEqual({ pid: 42, startTime: undefined });
  const identity = { startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001' };
  doubles.childIdentity.mockReturnValue(identity);
  state = { ...state, reservation: { ...state.reservation!, adoptedOwnerId: 'adopted' } };
  await vi.advanceTimersByTimeAsync(25);
  await starting;
  expect(state.reservation).toMatchObject({ adoptedOwnerId: 'adopted', child: { pid: 42, startTime: identity.startTime } });
  expect(state.failures).toEqual([]);
  expect(doubles.spawn).toHaveBeenCalledOnce();
});
it.each(['disabled', 'owner', 'reservation', 'empty'] as const)('does not spawn when %s excludes launch', async (condition) => {
  if (condition === 'disabled') doubles.config.mockReturnValue({ autoRun: false });
  if (condition === 'owner') doubles.owner.mockReturnValue({ ownerId: 'manual-watch' });
  if (condition === 'reservation') state.reservation = { token: 'reserved', launcher: { pid: 10 } };
  if (condition === 'empty') doubles.pending.mockReturnValue([]);
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).not.toHaveBeenCalled();
  if (condition === 'empty') expect(state.requested).toBe(false);
});
it.each([false, true])('launches a detached CLI, waits for adoption, and blocks concurrent launch (built CLI: %s)', async (built) => {
  doubles.exists.mockReturnValue(built);
  await Promise.all([ensureManagerRun('/project', 'turn-ended'), ensureManagerRun('/project', 'turn-ended')]);
  expect(doubles.spawn).toHaveBeenCalledTimes(1);
  const [command, args, options] = doubles.spawn.mock.calls[0]!;
  expect(command).toBe(process.execPath);
  expect(args).toContain('run');
  expect(args.some((arg: string) => arg.endsWith(built ? 'index.js' : 'index.ts'))).toBe(true);
  expect(options).toMatchObject({ cwd: '/project', detached: true, shell: false, stdio: ['ignore', 99, 99], env: { TAKT_MANAGER_RUN_TOKEN: state.reservation!.token } });
  expect(state.reservation).toMatchObject({ adoptedOwnerId: 'adopted', child: { pid: 42 } });
  expect(doubles.close).toHaveBeenCalledExactlyOnceWith(99);
});
it.each([false, true])('preserves a manager launch request for ordinary pending work until the owner releases (pending: %s)', async (pending) => {
  state.requested = false;
  doubles.owner.mockReturnValue({ ownerId: 'manual-watch' });
  if (!pending) doubles.pending.mockReturnValue([]);
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(state.requested).toBe(pending);
  doubles.owner.mockReturnValue(undefined);
  await ensureManagerRun('/project', 'recovery');
  expect(doubles.spawn).toHaveBeenCalledTimes(pending ? 1 : 0);
  expect(state.requested).toBe(false);
});
it('saves a launch diagnostic and releases an unstarted reservation without discarding the task', async () => {
  doubles.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('injected spawn failure')));
    return child;
  });
  await ensureManagerRun('/project', 'turn-ended');
  expect(state.reservation).toBeUndefined();
  expect(state.failures).toEqual([expect.objectContaining({ message: 'injected spawn failure' })]);
  expect(doubles.pending()).toEqual([{ name: 'saved-task', status: 'pending', content: 'work' }]);
  expect(doubles.close).toHaveBeenCalledTimes(1);
});

it.each(['recovery', 'turn-ended'] as const)('requires a saved request during %s', async (trigger) => {
  state.requested = false;
  await ensureManagerRun('/project', trigger);
  expect(doubles.spawn).toHaveBeenCalledTimes(trigger === 'turn-ended' ? 1 : 0);
});

it('recovers a stopped reservation even when automatic execution is disabled', async () => {
  doubles.config.mockReturnValue({ autoRun: false });
  state = { requested: false, failures: [], reservation: { token: 'stopped', launcher: { pid: 10 } } };
  doubles.recover.mockImplementation(() => { state = { requested: true, failures: [] }; return state; });
  await ensureManagerRun('/project', 'recovery');
  expect(doubles.recover).toHaveBeenCalledOnce();
  expect(state).toEqual({ requested: true, failures: [] });
  expect(doubles.spawn).not.toHaveBeenCalled();
});

it('preserves a turn launch request while automatic execution is disabled', async () => {
  state.requested = false;
  doubles.config.mockReturnValue({ autoRun: false });
  await ensureManagerRun('/project', 'turn-ended');
  expect(state.requested).toBe(true);
  expect(doubles.spawn).not.toHaveBeenCalled();
});

it.each([false, true])('ignores individually unreadable pending tasks with an owner: %s', async (owned) => {
  state.requested = false;
  if (owned) doubles.owner.mockReturnValue({ ownerId: 'manual' });
  const good = { name: 'good', status: 'pending', content: 'work' };
  const bad = { name: 'bad', status: 'pending', content_file: 'missing' };
  doubles.resolve.mockImplementation((_cwd, task) => {
    if (task.name === 'bad') throw new Error('missing content');
    return 'work';
  });
  for (const tasks of [[bad, good], [good, bad]]) {
    state = { requested: false, failures: [] };
    doubles.spawn.mockClear();
    doubles.pending.mockReturnValue(tasks);
    await ensureManagerRun('/project', 'turn-ended');
    expect(doubles.spawn).toHaveBeenCalledTimes(owned ? 0 : 1);
    expect(state.requested).toBe(owned);
  }
  state = { requested: false, failures: [] };
  doubles.spawn.mockClear();
  doubles.pending.mockReturnValue([bad, { ...good, status: 'completed' }]);
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(state.requested).toBe(false);
});

it('reports a whole queue failure without treating it as an individually unreadable task', async () => {
  doubles.pending.mockImplementation(() => { throw new Error('invalid tasks.yaml'); });
  await ensureManagerRun('/project', 'turn-ended');
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(state.failures).toHaveLength(1);
  expect(state.requested).toBe(true);
});
