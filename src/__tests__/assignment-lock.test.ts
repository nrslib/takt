import { expect, it, vi, beforeEach } from 'vitest';
import { acquireRepositoryAssignmentLocks, withRepositoryAssignmentLocks } from '../infra/conversations/assignmentLock.js';
import { conversationId } from '../infra/conversations/identity.js';

const doubles = vi.hoisted(() => ({ acquire: vi.fn(), mkdir: vi.fn() }));
vi.mock('../infra/daemon/lock.js', () => ({ FileAsyncLock: class { acquire = doubles.acquire; } }));
vi.mock('node:fs/promises', () => ({ realpath: async () => '/config', mkdir: doubles.mkdir }));
beforeEach(() => vi.resetAllMocks());

it('initializes the config root and acquires a separate stable lock for each canonical repository', async () => {
  const release = vi.fn(async () => {}); doubles.acquire.mockResolvedValue(release);
  const signal = new AbortController().signal;
  const unlock = await acquireRepositoryAssignmentLocks('/new-config', ['/b', '/a', '/b'], signal);
  const expected = ['/a', '/b'].map((repositoryDirectory) => `/config/conversations/assignment-locks/${conversationId({ kind: 'repository', repositoryDirectory })}.lock`).sort();
  expect(doubles.mkdir).toHaveBeenCalledWith('/new-config', { recursive: true, mode: 0o700 });
  expect(doubles.acquire.mock.calls.map(([path]) => path)).toEqual(expected);
  expect(release).not.toHaveBeenCalled(); await unlock(); expect(release).toHaveBeenCalledTimes(2);
});

it('releases a failed publication and allows a later operation', async () => {
  const release = vi.fn(async () => {}); doubles.acquire.mockResolvedValue(release);
  const signal = new AbortController().signal;
  await expect(withRepositoryAssignmentLocks('/config', ['/a'], signal, async () => { throw new Error('save failed'); })).rejects.toThrow('save failed');
  expect(release).toHaveBeenCalledOnce();
  await expect(withRepositoryAssignmentLocks('/config', ['/a'], signal, async () => 'retry')).resolves.toBe('retry');
});
