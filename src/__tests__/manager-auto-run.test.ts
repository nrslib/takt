import { beforeEach, expect, it, vi } from 'vitest';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  config: vi.fn(), owner: vi.fn(), pending: vi.fn(), resolve: vi.fn(),
  diagnostic: vi.fn(), goal: vi.fn(), register: vi.fn(), daemon: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; } }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/config/paths.js', () => ({ getGlobalConfigDir: () => '/config' }));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: doubles.register }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.daemon }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.pending() }; } } }));
vi.mock('../infra/task/mapper.js', () => ({ resolveTaskContent: doubles.resolve }));
vi.mock('../infra/task/project-execution-lock.js', () => ({ getProjectExecutionOwner: doubles.owner }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.diagnostic }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.config.mockReturnValue({ autoRun: true });
  doubles.goal.mockReturnValue(goalRecord());
  doubles.pending.mockReturnValue([{ name: 'saved-task', status: 'pending', content: 'work', goal_id: 'goal' }]);
});

it('registers the project before ensuring the daemon instead of spawning a run', async () => {
  await ensureManagerRun('/project');
  expect(doubles.register).toHaveBeenCalledExactlyOnceWith({
    globalConfigDirectory: '/config', projectDirectory: '/project', command: 'manager', managerUsed: true,
  });
  expect(doubles.daemon).toHaveBeenCalledOnce();
  expect(doubles.register.mock.invocationCallOrder[0]).toBeLessThan(doubles.daemon.mock.invocationCallOrder[0]!);
});
it.each(['disabled', 'run', 'watch', 'empty', 'ordinary', 'paused', 'aborted'] as const)(
  'does not request automatic execution when %s excludes work', async (condition) => {
    if (condition === 'disabled') doubles.config.mockReturnValue({ autoRun: false });
    if (condition === 'run' || condition === 'watch') doubles.owner.mockReturnValue({ kind: condition });
    if (condition === 'empty') doubles.pending.mockReturnValue([]);
    if (condition === 'ordinary') doubles.pending.mockReturnValue([{ name: 'ordinary', status: 'pending' }]);
    if (condition === 'paused' || condition === 'aborted') doubles.goal.mockReturnValue({ ...goalRecord(), executionStatus: condition });
    await ensureManagerRun('/project');
    expect(doubles.register).not.toHaveBeenCalled();
    expect(doubles.daemon).not.toHaveBeenCalled();
  });
it('reevaluates the same pending queue after resume and lock release', async () => {
  doubles.goal.mockReturnValue({ ...goalRecord(), executionStatus: 'paused' });
  await ensureManagerRun('/project');
  expect(doubles.daemon).not.toHaveBeenCalled();
  doubles.goal.mockReturnValue(goalRecord());
  doubles.owner.mockReturnValue({ kind: 'run' });
  await ensureManagerRun('/project');
  expect(doubles.daemon).not.toHaveBeenCalled();
  doubles.owner.mockReturnValue(undefined);
  await ensureManagerRun('/project');
  expect(doubles.daemon).toHaveBeenCalledOnce();
  expect(doubles.pending()).toHaveLength(1);
});
it('skips unreadable pending tasks while requesting readable goal work', async () => {
  doubles.resolve.mockImplementation((_cwd, task) => { if (task.name === 'bad') throw new Error('missing content'); });
  const good = { name: 'good', status: 'pending', goal_id: 'goal' };
  const bad = { ...good, name: 'bad' };
  for (const tasks of [[bad, good], [good, bad]]) {
    doubles.daemon.mockClear();
    doubles.pending.mockReturnValue(tasks);
    await ensureManagerRun('/project');
    expect(doubles.daemon).toHaveBeenCalledOnce();
  }
  doubles.daemon.mockClear();
  doubles.pending.mockReturnValue([bad]);
  await ensureManagerRun('/project');
  expect(doubles.daemon).not.toHaveBeenCalled();
});
it.each(['queue', 'register', 'daemon'] as const)('reports a %s failure and permits retry without discarding work', async (stage) => {
  const failure = new Error('injected failure');
  if (stage === 'queue') doubles.pending.mockImplementationOnce(() => { throw failure; });
  else doubles[stage].mockRejectedValueOnce(failure);
  await ensureManagerRun('/project');
  expect(doubles.diagnostic).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
  expect(doubles.pending()).toHaveLength(1);
  await ensureManagerRun('/project');
  expect(doubles.daemon).toHaveBeenCalled();
});
it.each(['queue', 'register', 'daemon'] as const)('propagates a %s failure without notifying when requested', async (stage) => {
  const failure = new Error('injected failure');
  if (stage === 'queue') doubles.pending.mockImplementationOnce(() => { throw failure; });
  else doubles[stage].mockRejectedValueOnce(failure);
  await expect(ensureManagerRun('/project', { notifyOnFailure: false })).rejects.toBe(failure);
  expect(doubles.diagnostic).not.toHaveBeenCalled();
});
