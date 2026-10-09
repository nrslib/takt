import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ config: vi.fn(), owner: vi.fn(), pending: vi.fn(), spawn: vi.fn(), exists: vi.fn(), open: vi.fn(), close: vi.fn(), resolve: vi.fn(), diagnostic: vi.fn() }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.pending() }; } } }));
vi.mock('../infra/task/mapper.js', () => ({ resolveTaskContent: doubles.resolve }));
vi.mock('../infra/task/project-execution-lock.js', () => ({ getProjectExecutionOwner: doubles.owner }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: doubles.diagnostic }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: doubles.exists, openSync: doubles.open, closeSync: doubles.close }));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { MANAGER_GOAL_TASKS_ENV } from '../shared/constants.js';
beforeEach(() => {
  vi.resetAllMocks();
  doubles.config.mockReturnValue({ autoRun: true, mainMerge: 'approve' });
  doubles.pending.mockReturnValue([{ name: 'saved-task', status: 'pending', content: 'work', goal_id: 'goal' }]);
  doubles.exists.mockReturnValue(true);
  doubles.open.mockReturnValue(99);
  doubles.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
afterEach(() => vi.unstubAllEnvs());
it.each(['disabled', 'run', 'watch', 'empty', 'ordinary'] as const)('does not spawn when %s excludes launch', async (condition) => {
  if (condition === 'disabled') doubles.config.mockReturnValue({ autoRun: false, mainMerge: 'approve' });
  if (condition === 'run' || condition === 'watch') doubles.owner.mockReturnValue({ kind: condition });
  if (condition === 'empty') doubles.pending.mockReturnValue([]);
  if (condition === 'ordinary') doubles.pending.mockReturnValue([{ name: 'ordinary', status: 'pending', content: 'work' }]);
  await ensureManagerRun('/project');
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it.each([false, true])('launches a detached CLI and returns after spawn (built CLI: %s)', async (built) => {
  doubles.exists.mockReturnValue(built);
  vi.stubEnv('TAKT_MANAGER_GOAL_OWNERS', JSON.stringify({ goal: 'owner' }));
  vi.stubEnv('TAKT_MANAGER_GOAL_EVENT_CONTEXT', JSON.stringify({ goalId: 'goal', eventId: 'event' }));
  await ensureManagerRun('/project');
  const [command, args, options] = doubles.spawn.mock.calls[0]!;
  expect(command).toBe(process.execPath);
  expect(args).toContain('run');
  expect(args.some((arg: string) => arg.endsWith(built ? 'index.js' : 'index.ts'))).toBe(true);
  expect(options).toMatchObject({ cwd: '/project', detached: true, shell: false, stdio: ['ignore', 99, 99] });
  expect(options.env.TAKT_MANAGER_GOAL_OWNERS).toBeUndefined();
  expect(options.env.TAKT_MANAGER_GOAL_EVENT_CONTEXT).toBeUndefined();
  expect(options.env[MANAGER_GOAL_TASKS_ENV]).toBe('1');
  expect(doubles.spawn.mock.results[0]!.value.unref).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledExactlyOnceWith(99);
});
it('allows both launchers to spawn before execution ownership is acquired', async () => {
  await Promise.all([ensureManagerRun('/project'), ensureManagerRun('/project')]);
  expect(doubles.spawn).toHaveBeenCalledTimes(2);
  expect(doubles.diagnostic).not.toHaveBeenCalled();
});
it('records a spawn error without discarding the pending task and permits the next attempt', async () => {
  doubles.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('injected spawn failure')));
    return child;
  });
  await ensureManagerRun('/project');
  expect(doubles.diagnostic).toHaveBeenCalledExactlyOnceWith('/project', expect.objectContaining({ message: 'injected spawn failure' }));
  expect(doubles.pending()).toHaveLength(1);
  expect(doubles.close).toHaveBeenCalledExactlyOnceWith(99);
  await ensureManagerRun('/project');
  expect(doubles.spawn).toHaveBeenCalledTimes(2);
});
it('starts pending work once the previous execution owner has released its lock', async () => {
  doubles.owner.mockReturnValueOnce({ kind: 'run' });
  await ensureManagerRun('/project');
  expect(doubles.spawn).not.toHaveBeenCalled();
  await ensureManagerRun('/project');
  expect(doubles.spawn).toHaveBeenCalledOnce();
});
it('skips unreadable pending tasks while executing readable work', async () => {
  const good = { name: 'good', status: 'pending', content: 'work', goal_id: 'goal' };
  const bad = { name: 'bad', status: 'pending', content_file: 'missing', goal_id: 'goal' };
  doubles.resolve.mockImplementation((_cwd, task) => {
    if (task.name === 'bad') throw new Error('missing content');
    return 'work';
  });
  for (const tasks of [[bad, good], [good, bad]]) {
    doubles.spawn.mockClear();
    doubles.pending.mockReturnValue(tasks);
    await ensureManagerRun('/project');
    expect(doubles.spawn).toHaveBeenCalledOnce();
  }
  doubles.spawn.mockClear();
  doubles.pending.mockReturnValue([bad, { ...good, status: 'completed' }]);
  await ensureManagerRun('/project');
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it('records a whole queue read failure without spawning', async () => {
  doubles.pending.mockImplementation(() => { throw new Error('invalid tasks.yaml'); });
  await ensureManagerRun('/project');
  expect(doubles.spawn).not.toHaveBeenCalled();
  expect(doubles.diagnostic).toHaveBeenCalledOnce();
});
