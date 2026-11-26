import { beforeEach, expect, it, vi } from 'vitest';
import { resolveManagerWorkspaceAccess, managerWorkspaceAccessNotice } from '../features/manager/workspaceAccess.js';
import { normalizeOpenCodeWorkspaceDirectories } from '../infra/opencode/external-directories.js';

vi.mock('../infra/opencode/external-directories.js', () => ({ normalizeOpenCodeWorkspaceDirectories: vi.fn() }));

beforeEach(() => {
  vi.mocked(normalizeOpenCodeWorkspaceDirectories).mockReset().mockImplementation((directories) => [...directories!]);
});

it('uses every canonical registered directory once and retains its owner', () => {
  vi.mocked(normalizeOpenCodeWorkspaceDirectories).mockImplementation((directories) =>
    directories!.map((directory) => directory === '/b-link' ? '/b' : directory));
  expect(resolveManagerWorkspaceAccess('conversation', ['/c', '/b-link', '/b'])).toEqual({
    access: { ownerId: 'conversation', directories: ['/b', '/c'] }, missingDirectories: [],
  });
  expect(vi.mocked(normalizeOpenCodeWorkspaceDirectories).mock.calls.map(([directories]) => directories))
    .toEqual([['/c'], ['/b-link'], ['/b']]);
});

it.each(['ENOENT', 'ENOTDIR'])('excludes a missing registration without broadening access (%s)', (code) => {
  const registered = ['/missing', '/present'];
  vi.mocked(normalizeOpenCodeWorkspaceDirectories).mockImplementation((directories) => {
    if (directories![0] === '/missing') throw Object.assign(new Error('missing'), { code });
    return [...directories!];
  });
  expect(resolveManagerWorkspaceAccess('conversation', registered)).toEqual({
    access: { ownerId: 'conversation', directories: ['/present'] }, missingDirectories: ['/missing'],
  });
  expect(registered).toEqual(['/missing', '/present']);
});

it.each(['EACCES', 'EIO'])('propagates unexpected directory errors (%s)', (code) => {
  const error = Object.assign(new Error('filesystem failure'), { code });
  vi.mocked(normalizeOpenCodeWorkspaceDirectories).mockImplementation(() => { throw error; });
  expect(() => resolveManagerWorkspaceAccess('conversation', ['/registered'])).toThrow(error);
});

it('preserves rejection of invalid paths instead of substituting a broader directory', () => {
  const error = new Error('invalid directory');
  vi.mocked(normalizeOpenCodeWorkspaceDirectories).mockImplementation(() => { throw error; });
  expect(() => resolveManagerWorkspaceAccess('conversation', ['relative'])).toThrow(error);
});

it.each(['ja', 'en'] as const)('reports additions and missing registrations in %s', (language) => {
  const notice = managerWorkspaceAccessNotice(['/a'], ['/a', '/b', '/c'], ['/missing'], language);
  for (const directory of ['/b', '/c', '/missing']) expect(notice).toContain(directory);
  expect(notice).toMatch(language === 'ja' ? /次のターン/u : /next turn/i);
  expect(notice).toMatch(language === 'ja' ? /存在しない/u : /do not exist/i);
});

it('does not announce unchanged registrations or removals as additions', () => {
  expect(managerWorkspaceAccessNotice(['/a', '/b'], ['/a', '/b'], [], 'ja')).toBe('');
  expect(managerWorkspaceAccessNotice(['/a', '/b'], ['/a'], [], 'en')).toBe('');
});
