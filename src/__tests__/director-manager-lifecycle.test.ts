import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addDirectorManager, fireDirectorManager } from '../features/director/managerLifecycle.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { conversationId } from '../infra/conversations/identity.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), register: vi.fn(), goals: vi.fn(), setFired: vi.fn(), isFired: vi.fn(), realpath: vi.fn() }));
vi.mock('../infra/task/gitRepositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.git }));
vi.mock('../infra/conversations/managerLifecycleLock.js', () => ({
  withManagerLifecycleLock: async (_directory: string, _id: string, signal: AbortSignal, action: () => Promise<unknown>) => {
    signal.throwIfAborted(); return action();
  },
  withManagerLifecycleLocks: async (_directory: string, _ids: readonly string[], signal: AbortSignal, action: () => Promise<unknown>) => {
    signal.throwIfAborted(); return action();
  },
}));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(),
  realpath: doubles.realpath, stat: async () => ({ isDirectory: () => true }), access: vi.fn() }));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: doubles.register }));
vi.mock('../infra/director/managerGoals.js', () => ({ readDirectorManagerGoals: async function* (directory: string, signal: AbortSignal) {
  for (const goal of await doubles.goals(directory, signal)) yield goal;
} }));
vi.mock('../infra/director/managerState.js', () => ({ DirectorManagerStateStore: class { setFired = doubles.setFired; isFired = doubles.isFired; } }));
const identity = { kind: 'repository' as const, repositoryDirectory: '/repo' };
const assignment = { ...identity, repositoryDirectories: ['/repo'] };
const id = conversationId(assignment);
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  doubles.git.mockResolvedValue('/repo');
  doubles.realpath.mockResolvedValue('/repo');
  doubles.isFired.mockResolvedValue(false);
  doubles.goals.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

function conversations() {
  const routing = new DaemonRouting('/config');
  vi.spyOn(routing, 'routes').mockResolvedValue([]);
  vi.spyOn(routing, 'assignments').mockResolvedValue([identity]);
  vi.spyOn(routing, 'display').mockResolvedValue(assignment);
  vi.spyOn(routing, 'permits').mockResolvedValue(true);
  return { routing, ensure: vi.fn(async () => {}) };
}

it('prepares the resolved conversation and returns its existing identity', async () => {
  const owner = conversations();
  const abortSignal = signal();
  expect(await addDirectorManager(owner, '/repo/subdirectory', abortSignal)).toEqual({ managerId: id });
  expect(doubles.git).toHaveBeenCalledExactlyOnceWith('/repo/subdirectory');
  expect(doubles.register).toHaveBeenCalledWith({ globalConfigDirectory: '/config', projectDirectory: '/repo', command: 'director', managerUsed: true, signal: abortSignal });
  expect(owner.ensure).toHaveBeenCalledWith(identity, abortSignal);
  expect(owner.ensure.mock.invocationCallOrder[0]).toBeLessThan(doubles.register.mock.invocationCallOrder[0]!);
  expect(doubles.setFired).toHaveBeenCalledWith(id, false, abortSignal);
});

it('reuses a resolved workspace identity when preparing a member repository', async () => {
  const owner = conversations();
  const workspace = { kind: 'workspace' as const, workspaceId: '550e8400-e29b-41d4-a716-446655440000' };
  vi.mocked(owner.routing.routes).mockResolvedValue([{ repositoryDirectory: '/repo', workspaceId: workspace.workspaceId }]);
  expect(await addDirectorManager(owner, '/repo', signal())).toEqual({ managerId: conversationId(workspace) });
  expect(owner.ensure).toHaveBeenCalledWith(workspace, expect.any(AbortSignal));
});

it('rejects a relative path before Git validation or registration', async () => {
  await expect(addDirectorManager(conversations(), 'relative', signal())).rejects.toThrow();
  expect(doubles.git).not.toHaveBeenCalled();
  expect(doubles.register).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('does not register or prepare a repository that fails Git validation', async () => {
  doubles.git.mockRejectedValue(new Error('not Git'));
  const owner = conversations();
  await expect(addDirectorManager(owner, '/repo', signal())).rejects.toThrow();
  expect(doubles.register).not.toHaveBeenCalled();
  expect(owner.ensure).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('keeps a fired manager excluded after preparation failure and permits a later retry', async () => {
  const owner = conversations();
  owner.ensure.mockRejectedValueOnce(new Error('conversation unavailable'));
  await expect(addDirectorManager(owner, '/repo', signal())).rejects.toThrow();
  expect(doubles.setFired).not.toHaveBeenCalled();
  expect(doubles.register).not.toHaveBeenCalled();
  await expect(addDirectorManager(owner, '/repo', signal())).resolves.toEqual({ managerId: id });
  expect(doubles.setFired).toHaveBeenCalledOnce();
});

it('fires a manager without goals by updating only its director lifecycle state', async () => {
  const abortSignal = signal();
  expect(await fireDirectorManager(conversations().routing, id, abortSignal)).toEqual({ managerId: id });
  expect(doubles.setFired).toHaveBeenCalledExactlyOnceWith(id, true, abortSignal);
  expect(doubles.register).not.toHaveBeenCalled();
});

it.each([
  { status: 'created', executionStatus: 'active' }, { status: 'created', executionStatus: 'paused' },
  { status: 'awaiting_merge', executionStatus: 'active' },
])('refuses fire for $status/$executionStatus without updating state', async (state) => {
  const goal = { ...goalRecord(), ...state, ...(state.status === 'awaiting_merge' ? { completion: {
    goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'ready', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } } : {}) };
  doubles.goals.mockResolvedValue([goal]);
  await expect(fireDirectorManager(conversations().routing, id, signal())).rejects.toThrow();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('refuses fire when goal reading reports a corrupt record', async () => {
  doubles.goals.mockRejectedValue(new Error('invalid JSON'));
  await expect(fireDirectorManager(conversations().routing, id, signal())).rejects.toThrow();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('refuses fire when an assigned repository is unreadable', async () => {
  doubles.realpath.mockRejectedValue(new Error('unreadable'));
  await expect(fireDirectorManager(conversations().routing, id, signal())).rejects.toThrow();
  expect(doubles.goals).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('does not create lifecycle state for an unknown manager', async () => {
  const owner = conversations();
  vi.mocked(owner.routing.assignments).mockResolvedValue([]);
  await expect(fireDirectorManager(owner.routing, id, signal())).rejects.toThrow();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('does not fire a manager that is already excluded', async () => {
  doubles.isFired.mockResolvedValue(true);
  await expect(fireDirectorManager(conversations().routing, id, signal())).rejects.toThrow();
  expect(doubles.goals).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('refuses a repository that no longer belongs to the selected manager', async () => {
  const owner = conversations();
  vi.mocked(owner.routing.permits).mockResolvedValue(false);
  await expect(fireDirectorManager(owner.routing, id, signal())).rejects.toThrow();
  expect(doubles.goals).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('checks an unreadable workspace member even when readable members have no goals', async () => {
  const owner = conversations();
  const workspace = { kind: 'workspace' as const, workspaceId: '550e8400-e29b-41d4-a716-446655440000' };
  const workspaceId = conversationId(workspace);
  vi.mocked(owner.routing.assignments).mockResolvedValue([workspace]);
  vi.mocked(owner.routing.display).mockResolvedValue({ ...workspace, name: 'apps', repositoryDirectories: ['/repo', '/missing'] });
  doubles.realpath.mockImplementation(async (path: string) => {
    if (path === '/missing') throw new Error('unreadable member');
    return path;
  });
  await expect(fireDirectorManager(owner.routing, workspaceId, signal())).rejects.toThrow();
  expect(owner.routing.display).toHaveBeenCalledWith(workspace);
  expect(doubles.goals).not.toHaveBeenCalled();
  expect(doubles.realpath).toHaveBeenLastCalledWith('/missing');
  expect(doubles.setFired).not.toHaveBeenCalled();
});

it('refuses a member that is no longer a Git repository before reading goals', async () => {
  doubles.git.mockRejectedValue(new Error('not a repository'));
  await expect(fireDirectorManager(conversations().routing, id, signal())).rejects.toThrow();
  expect(doubles.goals).not.toHaveBeenCalled();
  expect(doubles.setFired).not.toHaveBeenCalled();
});
