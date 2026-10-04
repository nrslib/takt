import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertContained,
  resolveRunPaths,
  resolveStatePaths,
} from '../core/execution/locations.js';
import { ProjectLocalStateLocator } from '../infra/task/stateLocator.js';
import {
  readProjectRegistry,
  registerProject,
} from '../infra/config/global/projectRegistry.js';
import { resolveCentralWorktree } from '../infra/task/centralWorktree.js';

const temporaryDirectories = new Set<string>();

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('execution locations', () => {
  it('uses a channel-neutral central state layout and absolute contained run paths', async () => {
    const global = await createTemporaryDirectory('takt-locations-global-');
    const state = resolveStatePaths(global, '11111111-1111-4111-8111-111111111111');
    expect(state.stateDirectory).toBe(join(global, 'state', 'projects', '11111111-1111-4111-8111-111111111111'));
    expect(state.tasksFile).toBe(join(state.stateDirectory, 'tasks.yaml'));
    expect(state.runsDirectory).toBe(join(state.stateDirectory, 'runs'));
    expect(state.stateDirectory.startsWith('/')).toBe(true);

    const run = resolveRunPaths(state, 'run-1');
    expect(run.runRootAbs).toBe(join(state.runsDirectory, 'run-1'));
    expect(run.metaAbs).toBe(join(run.runRootAbs, 'meta.json'));
    assertContained(state.runsDirectory, run.metaAbs);
    expect(() => resolveRunPaths(state, '../outside')).toThrow('runId is invalid');
  });

  it('keeps CLI state project-local while the central locator stays explicit', async () => {
    const project = await createTemporaryDirectory('takt-locations-project-');
    const locations = new ProjectLocalStateLocator().resolve(project);
    expect(locations.projectDirectory).toBe(project);
    expect(locations.executionDirectory).toBe(project);
    expect(locations.stateDirectory).toBe(join(project, '.takt'));
    expect(new ProjectLocalStateLocator().paths(locations).tasksFile).toBe(join(project, '.takt', 'tasks.yaml'));
  });

  it('uses canonical path lookup with persistent state ids', async () => {
    const global = await createTemporaryDirectory('takt-locations-registry-');
    const parent = await createTemporaryDirectory('takt-locations-parent-');
    const project = join(parent, 'project');
    await mkdir(project);
    const alias = join(parent, 'alias');
    await symlink(project, alias);
    const first = await registerProject({ globalConfigDirectory: global, projectDirectory: alias, command: 'ui' });
    const second = await registerProject({ globalConfigDirectory: global, projectDirectory: project, command: 'ui' });
    expect(second.locationId).toBe(first.locationId);
    expect(second.stateId).toBe(first.stateId);
    expect((await readProjectRegistry(global)).projects[0]).toMatchObject({
      canonicalDirectory: project,
      locationId: first.locationId,
      stateId: first.stateId,
      fingerprint: { dev: expect.any(Number), ino: expect.any(Number) },
    });
  });

  it('resolves the central worktree matrix without a project-local fallback', () => {
    const base = {
      projectDirectory: '/workspace/project',
      executionDirectory: '/workspace/project',
      globalConfigDirectory: '/config',
      stateId: '11111111-1111-4111-8111-111111111111',
    };
    expect(resolveCentralWorktree({ ...base, request: false })).toMatchObject({ enabled: false });
    expect(resolveCentralWorktree({ ...base, request: '/explicit/worktree' })).toMatchObject({
      enabled: true,
      baseDirectory: '/explicit/worktree',
      skipProjectLocalTaktSync: true,
    });
    expect(resolveCentralWorktree({
      ...base,
      request: true,
      configuredWorktreeDirectory: '/configured/worktrees',
    }).baseDirectory).toBe('/configured/worktrees');
  });
});
