import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { listDirectorManagers } from '../features/director/managers.js';
import type { resolveCurrentManagerAssignment } from '../features/manager/assignment.js';
import type { readProjectRegistry, RegisteredProject } from '../infra/config/global/projectRegistry.js';
import type { readWorkspaceRegistry } from '../infra/config/global/workspaceRegistry.js';

const doubles = vi.hoisted(() => ({
  projects: vi.fn<typeof readProjectRegistry>(),
  workspaces: vi.fn<typeof readWorkspaceRegistry>(),
  resolve: vi.fn<typeof resolveCurrentManagerAssignment>(),
  realpath: vi.fn<(directory: string) => Promise<string>>(),
  stat: vi.fn(), access: vi.fn(), warn: vi.fn(),
}));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ readProjectRegistry: doubles.projects }));
vi.mock('../infra/config/global/workspaceRegistry.js', () => ({ readWorkspaceRegistry: doubles.workspaces }));
vi.mock('../features/manager/assignment.js', () => ({ resolveCurrentManagerAssignment: doubles.resolve }));
vi.mock('node:fs/promises', () => ({ realpath: doubles.realpath, stat: doubles.stat, access: doubles.access }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ warn: doubles.warn }) }));

function project(directory: string, overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  const id = createHash('sha256').update(directory).digest('hex');
  return { version: 2, locationId: id, id, canonicalDirectory: directory, projectDirectory: directory,
    stateId: '550e8400-e29b-41d4-a716-446655440000', fingerprint: { dev: 1, ino: 1 },
    displayName: directory, createdAt: '2026-10-30T00:00:00Z', lastSeenAt: '2026-10-30T00:00:00Z',
    lastCommand: 'manager', managerUsed: true, available: true, ...overrides };
}

function repository(directory: string) {
  return { kind: 'repository' as const, repositoryDirectory: directory, repositoryDirectories: [directory] };
}

beforeEach(() => {
  vi.resetAllMocks();
  doubles.projects.mockResolvedValue({ projects: [], warnings: [] });
  doubles.workspaces.mockResolvedValue([]);
  doubles.realpath.mockImplementation(async (directory) => directory);
  doubles.stat.mockResolvedValue({ isDirectory: () => true });
  doubles.access.mockResolvedValue(undefined);
  doubles.resolve.mockImplementation(async (identity) => {
    if (identity.kind !== 'repository') throw new Error('Repository identity required');
    return repository(identity.repositoryDirectory);
  });
});

it('continues after a project assignment fails and preserves its reason with sensitive values redacted', async () => {
  doubles.projects.mockResolvedValue({ projects: ['/a-good', '/b-broken', '/c-good'].map((directory) => project(directory)), warnings: [] });
  doubles.resolve.mockImplementation(async (identity) => {
    if (identity.kind !== 'repository') throw new Error('Repository identity required');
    if (identity.repositoryDirectory === '/b-broken') throw new Error('EACCES: permission denied; API_KEY=private-test-value');
    return repository(identity.repositoryDirectory);
  });

  const result = await listDirectorManagers('/config');

  expect(result).toEqual({ managers: [repository('/a-good'), repository('/c-good')],
    errors: [{ repositoryDirectory: '/b-broken', reason: expect.stringContaining('EACCES: permission denied') }] });
  expect(result.errors[0]!.reason).not.toContain('private-test-value');
  expect(doubles.resolve).toHaveBeenLastCalledWith({ kind: 'repository', repositoryDirectory: '/c-good' }, '/config');
});

it('lists marked and workspace projects once while preserving empty workspaces and excluding unmarked projects', async () => {
  const workspace = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'workspace', repositoryDirectories: ['/b-member'] };
  const empty = { id: '550e8400-e29b-41d4-a716-446655440001', name: 'empty', repositoryDirectories: [] };
  const assignment = { kind: 'workspace' as const, workspaceId: workspace.id, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories };
  doubles.projects.mockResolvedValue({ projects: [project('/a-good'), project('/b-member'), project('/ignored', { managerUsed: false })], warnings: [] });
  doubles.workspaces.mockResolvedValue([workspace, empty]);
  doubles.resolve.mockImplementation(async (identity) => {
    if (identity.kind !== 'repository') throw new Error('Repository identity required');
    return identity.repositoryDirectory === '/b-member' ? assignment : repository(identity.repositoryDirectory);
  });

  expect(await listDirectorManagers('/config')).toEqual({ managers: [assignment,
    { kind: 'workspace', workspaceId: empty.id, name: empty.name, repositoryDirectories: [] }, repository('/a-good')], errors: [] });
  expect(doubles.resolve).toHaveBeenCalledTimes(2);
  expect(doubles.realpath.mock.calls.map(([directory]) => directory)).toEqual(['/a-good', '/b-member']);
});

it('rejects an unavailable original registration even when its replacement has an available registration', async () => {
  doubles.projects.mockResolvedValue({ projects: [project('/replacement', { managerUsed: false }),
    project('/a-good'), project('/b-replaced', { available: false })], warnings: [] });
  doubles.realpath.mockImplementation(async (directory) => directory === '/b-replaced' ? '/replacement' : directory);

  const result = await listDirectorManagers('/config');

  expect(result).toMatchObject({ managers: [repository('/a-good')],
    errors: [{ repositoryDirectory: '/b-replaced', reason: expect.stringMatching(/\S/) }] });
  expect(doubles.resolve).toHaveBeenCalledExactlyOnceWith({ kind: 'repository', repositoryDirectory: '/a-good' }, '/config');
});
