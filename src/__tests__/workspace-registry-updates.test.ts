import { beforeEach, expect, it, vi } from 'vitest';
import { addWorkspaceRepository, createWorkspace, removeWorkspaceRepository, renameWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { withManagerLifecycleLock } from '../infra/conversations/managerLifecycleLock.js';
import { conversationId } from '../infra/conversations/identity.js';
import { deferred } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), lock: vi.fn(), assignment: vi.fn() }));
vi.mock('../infra/conversations/managerLifecycleLock.js', () => ({ withManagerLifecycleLock: doubles.lock }));
vi.mock('../infra/conversations/assignmentLock.js', () => ({
  withRepositoryAssignmentLocks: doubles.assignment,
}));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async (path: string) => path }));
vi.mock('../infra/config/project/sessionStore.js', () => ({ writeFileAtomic: doubles.write }));
vi.mock('node:fs/promises', () => ({ readFile: doubles.read, mkdir: vi.fn(), readdir: async () => [] }));
const id = '550e8400-e29b-41d4-a716-446655440000';
beforeEach(() => {
  vi.resetAllMocks();
  doubles.assignment.mockImplementation(async (_directory: string, _repositories: readonly string[], signal: AbortSignal, action: () => Promise<unknown>) => {
    signal.throwIfAborted(); return action();
  });
});

it('keeps a failed workspace publication unassigned and permits a successful retry', async () => {
  let saved: string | undefined; const released: string[][] = [];
  doubles.assignment.mockImplementation(async (_directory: string, repositories: string[], _signal: AbortSignal, action: () => Promise<unknown>) => {
    try { return await action(); } finally { released.push(repositories); }
  });
  doubles.write.mockImplementationOnce(() => { throw new Error('save failed'); }).mockImplementation((_path: string, value: string) => { saved = value; });
  const input = { globalConfigDirectory: '/config', name: 'apps', repositoryDirectories: ['/a', '/b'] };
  await expect(createWorkspace(input)).rejects.toThrow('save failed');
  expect(saved).toBeUndefined();
  const retried = await createWorkspace(input);
  expect(JSON.parse(saved!)).toEqual(retried);
  expect(released).toEqual([['/a', '/b'], ['/a', '/b']]);
});

it.each(['rename', 'remove'] as const)('preserves the latest members when %s overlaps an addition', async (operation) => {
  let saved = JSON.stringify({ id, name: 'apps', repositoryDirectories: ['/a'] });
  const reading = deferred<void>(); const resume = deferred<void>(); const secondAttempt = deferred<void>();
  let first = true;
  doubles.read.mockImplementation(async () => {
    const value = saved;
    if (first) { first = false; reading.resolve(); await resume.promise; }
    return value;
  });
  doubles.write.mockImplementation((_path: string, value: string) => { saved = value; });
  let tail = Promise.resolve();
  doubles.lock.mockImplementation(async (_directory: string, _id: string, signal: AbortSignal, action: () => Promise<unknown>) => {
    const previous = tail; const done = deferred<void>(); tail = done.promise;
    if (doubles.lock.mock.calls.length === 2) secondAttempt.resolve();
    await previous;
    try { signal.throwIfAborted(); return await action(); } finally { done.resolve(); }
  });
  const adding = addWorkspaceRepository('/config', id, '/b');
  await reading.promise;
  const updating = operation === 'rename' ? renameWorkspace('/config', id, 'renamed') : removeWorkspaceRepository('/config', id, '/a');
  await secondAttempt.promise;
  resume.resolve();
  await adding; await updating;
  expect(JSON.parse(saved)).toEqual({ id, name: operation === 'rename' ? 'renamed' : 'apps',
    repositoryDirectories: operation === 'rename' ? ['/a', '/b'] : ['/b'] });
  for (const call of vi.mocked(withManagerLifecycleLock).mock.calls) {
    expect(call.slice(0, 2)).toEqual(['/config', conversationId({ kind: 'workspace', workspaceId: id })]);
  }
});
