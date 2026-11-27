import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withWorkspaceEpicLock } from '../infra/epics/lock.js';
import { epicId, epicWorkspaceId } from './helpers/epic-fixtures.js';

const doubles = vi.hoisted(() => ({ realpath: vi.fn(), exclusive: vi.fn() }));
vi.mock('node:fs/promises', () => ({ realpath: doubles.realpath }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn() }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn() }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusiveAsync: doubles.exclusive }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.realpath.mockImplementation(async (path: string) => path.replace('/alias/', '/configuration/'));
  doubles.exclusive.mockImplementation(async (_path: string, action: () => Promise<unknown>) => action());
});

describe('workspace Epic exclusion scope', () => {
  it('waits for the asynchronous action and returns its result', async () => {
    const action = vi.fn(async () => 'saved');
    expect(await withWorkspaceEpicLock('/configuration', epicWorkspaceId, action)).toBe('saved');
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses the same exclusion key for aliases and separates different workspaces', async () => {
    await withWorkspaceEpicLock('/configuration', epicWorkspaceId, async () => undefined);
    await withWorkspaceEpicLock('/alias', epicWorkspaceId, async () => undefined);
    await withWorkspaceEpicLock('/configuration', epicId, async () => undefined);
    const keys = doubles.exclusive.mock.calls.map(([path]) => path);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it('propagates lock acquisition failure without starting the action', async () => {
    const failure = new Error('Cannot acquire workspace lock');
    doubles.exclusive.mockRejectedValueOnce(failure);
    const action = vi.fn(async () => undefined);
    await expect(withWorkspaceEpicLock('/configuration', epicWorkspaceId, action)).rejects.toBe(failure);
    expect(action).not.toHaveBeenCalled();
  });
});
