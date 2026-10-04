import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { createSharedClone, createSharedCloneAbortable } from '../infra/task/clone.js';
import { saveProjectConfig } from '../infra/config/project/projectConfig.js';
import type { ProjectConfig } from '../infra/config/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function createProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-clone-remote-base-'));
  tempDirs.push(tempDir);
  const projectRepo = path.join(tempDir, 'project');
  fs.mkdirSync(projectRepo);
  runGit(projectRepo, ['init', '--quiet', '--initial-branch=main']);
  runGit(projectRepo, ['config', 'user.email', 'takt@example.com']);
  runGit(projectRepo, ['config', 'user.name', 'TAKT Test']);
  fs.writeFileSync(path.join(projectRepo, 'README.md'), 'initial\n');
  runGit(projectRepo, ['add', 'README.md']);
  runGit(projectRepo, ['commit', '--quiet', '-m', 'initial']);
  return { tempDir, projectRepo, clonePath: path.join(tempDir, 'task-clone') };
}

const creators = [
  ['sync', createSharedClone],
  ['abortable', createSharedCloneAbortable],
] as const;

describe('shared clone remote-only base branches', () => {
  it.each(creators)('uses the latest fetched remote-only base (%s)', async (_mode, createClone) => {
    const { tempDir, projectRepo, clonePath } = createProject();
    const remoteRepo = path.join(tempDir, 'origin.git');
    const updaterRepo = path.join(tempDir, 'updater');
    const baseBranch = 'goal/remote-only';
    runGit(tempDir, ['init', '--bare', '--quiet', '--initial-branch=main', remoteRepo]);
    runGit(projectRepo, ['remote', 'add', 'origin', remoteRepo]);
    runGit(projectRepo, ['push', '--quiet', '-u', 'origin', 'main']);
    runGit(projectRepo, ['switch', '--quiet', '-c', baseBranch]);
    fs.writeFileSync(path.join(projectRepo, 'base.txt'), 'base v1\n');
    runGit(projectRepo, ['add', 'base.txt']);
    runGit(projectRepo, ['commit', '--quiet', '-m', 'base v1']);
    runGit(projectRepo, ['push', '--quiet', '-u', 'origin', baseBranch]);
    const staleBase = runGit(projectRepo, ['rev-parse', `refs/remotes/origin/${baseBranch}`]);
    runGit(projectRepo, ['switch', '--quiet', 'main']);
    runGit(projectRepo, ['branch', '-D', baseBranch]);

    runGit(tempDir, ['clone', '--quiet', '--branch', baseBranch, remoteRepo, updaterRepo]);
    runGit(updaterRepo, ['config', 'user.email', 'takt@example.com']);
    runGit(updaterRepo, ['config', 'user.name', 'TAKT Test']);
    fs.writeFileSync(path.join(updaterRepo, 'base.txt'), 'base v2\n');
    runGit(updaterRepo, ['commit', '--quiet', '-am', 'base v2']);
    runGit(updaterRepo, ['push', '--quiet', 'origin', baseBranch]);
    const expectedBase = runGit(updaterRepo, ['rev-parse', 'HEAD']);
    expect(staleBase).not.toBe(expectedBase);
    expect(() => runGit(projectRepo, ['show-ref', '--verify', `refs/heads/${baseBranch}`])).toThrow();
    saveGlobalConfig({ language: 'en', autoFetch: true });

    const branch = 'feature/new-task';
    const result = await createClone(projectRepo, { worktree: clonePath, taskSlug: 'remote-base', branch, baseBranch });

    expect(result).toMatchObject({ path: clonePath, branch });
    expect(runGit(clonePath, ['rev-parse', 'HEAD'])).toBe(expectedBase);
    expect(runGit(clonePath, ['branch', '--show-current'])).toBe(branch);
    expect(fs.readFileSync(path.join(clonePath, 'base.txt'), 'utf-8')).toBe('base v2\n');
    expect(() => runGit(projectRepo, ['show-ref', '--verify', `refs/heads/${baseBranch}`])).toThrow();
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(clonePath, ['remote'])).toBe('');
  });

  it.each(creators)('keeps the local base when fetching is unavailable (%s)', async (_mode, createClone) => {
    const { projectRepo, clonePath } = createProject();
    const baseBranch = 'goal/local-only';
    runGit(projectRepo, ['switch', '--quiet', '-c', baseBranch]);
    fs.writeFileSync(path.join(projectRepo, 'base.txt'), 'local base\n');
    runGit(projectRepo, ['add', 'base.txt']);
    runGit(projectRepo, ['commit', '--quiet', '-m', 'local base']);
    const expectedBase = runGit(projectRepo, ['rev-parse', 'HEAD']);
    runGit(projectRepo, ['switch', '--quiet', 'main']);
    saveGlobalConfig({ language: 'en', autoFetch: true });

    const result = await createClone(projectRepo, {
      worktree: clonePath, taskSlug: 'local-base', branch: 'feature/new-task', baseBranch,
    });

    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(expectedBase);
    expect(fs.readFileSync(path.join(result.path, 'base.txt'), 'utf-8')).toBe('local base\n');
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
  });
});

const submoduleModes: [string, ProjectConfig][] = [
  ['all', { submodules: 'all' }],
  ['selected path', { submodules: ['modules/selected lib'] }],
  ['legacy enabled', { withSubmodules: true }],
  ['disabled', { withSubmodules: false }],
];

function createSubmoduleProject(relativeUrls = false) {
  const project = createProject();
  const { tempDir, projectRepo } = project;
  const nestedRepo = path.join(tempDir, 'nested');
  const moduleRepo = path.join(tempDir, 'module');
  for (const repo of [nestedRepo, moduleRepo]) {
    fs.mkdirSync(repo);
    runGit(repo, ['init', '--quiet', '--initial-branch=main']);
    runGit(repo, ['config', 'user.email', 'takt@example.com']);
    runGit(repo, ['config', 'user.name', 'TAKT Test']);
  }
  fs.writeFileSync(path.join(nestedRepo, 'version.txt'), 'nested v1\n');
  runGit(nestedRepo, ['add', 'version.txt']);
  runGit(nestedRepo, ['commit', '--quiet', '-m', 'nested v1']);
  runGit(moduleRepo, ['submodule', 'add', '--quiet', nestedRepo, 'nested']);
  if (relativeUrls) {
    runGit(moduleRepo, ['config', '-f', '.gitmodules', 'submodule.nested.url', '../nested']);
  }
  runGit(moduleRepo, ['commit', '--quiet', '-am', 'module v1']);
  const initialModule = runGit(moduleRepo, ['rev-parse', 'HEAD']);
  for (const modulePath of ['modules/selected lib', 'modules/unselected']) {
    runGit(projectRepo, ['submodule', 'add', '--quiet', moduleRepo, modulePath]);
    if (relativeUrls) {
      runGit(projectRepo, ['config', '-f', '.gitmodules', `submodule.${modulePath}.url`, '../module']);
    }
  }
  runGit(projectRepo, ['commit', '--quiet', '-am', 'main modules']);

  fs.writeFileSync(path.join(nestedRepo, 'version.txt'), 'nested v2\n');
  runGit(nestedRepo, ['commit', '--quiet', '-am', 'nested v2']);
  const expectedNested = runGit(nestedRepo, ['rev-parse', 'HEAD']);
  runGit(path.join(moduleRepo, 'nested'), ['fetch', '--quiet', 'origin']);
  runGit(path.join(moduleRepo, 'nested'), ['checkout', '--quiet', expectedNested]);
  runGit(moduleRepo, ['commit', '--quiet', '-am', 'module v2']);
  const expectedModule = runGit(moduleRepo, ['rev-parse', 'HEAD']);

  const baseBranch = 'goal/module-base';
  runGit(projectRepo, ['switch', '--quiet', '-c', baseBranch]);
  for (const modulePath of ['modules/selected lib', 'modules/unselected']) {
    const moduleDir = path.join(projectRepo, modulePath);
    runGit(moduleDir, ['fetch', '--quiet', 'origin']);
    runGit(moduleDir, ['checkout', '--quiet', expectedModule]);
  }
  runGit(projectRepo, ['commit', '--quiet', '-am', 'base modules']);
  const expectedBase = runGit(projectRepo, ['rev-parse', 'HEAD']);
  const remoteRepo = path.join(tempDir, 'origin.git');
  runGit(tempDir, ['init', '--bare', '--quiet', '--initial-branch=main', remoteRepo]);
  runGit(projectRepo, ['remote', 'add', 'origin', remoteRepo]);
  runGit(projectRepo, ['push', '--quiet', 'origin', 'main', baseBranch]);
  runGit(projectRepo, ['switch', '--quiet', 'main']);
  runGit(projectRepo, ['branch', '-D', baseBranch]);
  for (const modulePath of ['modules/selected lib', 'modules/unselected']) {
    runGit(path.join(projectRepo, modulePath), ['checkout', '--quiet', initialModule]);
  }
  return { ...project, baseBranch, expectedBase, expectedModule, expectedNested, initialModule };
}

describe.each(creators)('fetched clone submodules (%s)', (_mode, createClone) => {
  it('preserves selected paths for subsequent updates without path arguments', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    const { projectRepo, clonePath, baseBranch } = createSubmoduleProject();
    const selectedPath = 'modules/selected lib';
    saveGlobalConfig({ language: 'en', autoFetch: true });
    saveProjectConfig(projectRepo, { submodules: [selectedPath] });

    await createClone(projectRepo, { worktree: clonePath, taskSlug: 'selected-modules', branch: 'feature/module-task', baseBranch });
    runGit(clonePath, ['submodule', 'update', '--init', '--recursive']);

    expect(fs.existsSync(path.join(clonePath, 'modules/unselected/.git'))).toBe(false);
    expect(runGit(clonePath, ['config', '--local', '--get-all', 'submodule.active'])).toBe(selectedPath);
  });

  it('resolves relative submodule URLs from the source repository', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    const { tempDir, projectRepo, baseBranch, expectedModule, expectedNested } = createSubmoduleProject(true);
    const clonePath = path.join(tempDir, 'isolated', 'task-clone');
    saveGlobalConfig({ language: 'en', autoFetch: true });
    saveProjectConfig(projectRepo, { submodules: 'all' });

    await createClone(projectRepo, { worktree: clonePath, taskSlug: 'relative-modules', branch: 'feature/module-task', baseBranch });

    const moduleDir = path.join(clonePath, 'modules/selected lib');
    expect(runGit(moduleDir, ['rev-parse', 'HEAD'])).toBe(expectedModule);
    expect(runGit(path.join(moduleDir, 'nested'), ['rev-parse', 'HEAD'])).toBe(expectedNested);
    expect(runGit(clonePath, ['remote'])).toBe('');
  });

  it('initializes submodules using the fetched tree rather than source HEAD URLs', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    const { tempDir, projectRepo, clonePath, baseBranch, expectedModule, expectedNested } = createSubmoduleProject();
    runGit(projectRepo, ['config', '-f', '.gitmodules', 'submodule.modules/selected lib.url', path.join(tempDir, 'unavailable-source-module')]);
    runGit(projectRepo, ['commit', '--quiet', '-am', 'source-only module URL']);
    saveGlobalConfig({ language: 'en', autoFetch: true });
    saveProjectConfig(projectRepo, { submodules: 'all' });

    await createClone(projectRepo, { worktree: clonePath, taskSlug: 'module-urls', branch: 'feature/module-task', baseBranch });

    const moduleDir = path.join(clonePath, 'modules/selected lib');
    expect(runGit(moduleDir, ['rev-parse', 'HEAD'])).toBe(expectedModule);
    expect(runGit(path.join(moduleDir, 'nested'), ['rev-parse', 'HEAD'])).toBe(expectedNested);
  });

  it.each(submoduleModes)('matches the fetched base using %s acquisition', async (_configName, config) => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    const { projectRepo, clonePath, baseBranch, expectedBase, expectedModule, expectedNested, initialModule } = createSubmoduleProject();
    saveGlobalConfig({ language: 'en', autoFetch: true });
    saveProjectConfig(projectRepo, config);

    await createClone(projectRepo, { worktree: clonePath, taskSlug: 'module-base', branch: 'feature/module-task', baseBranch });

    expect(runGit(clonePath, ['rev-parse', 'HEAD'])).toBe(expectedBase);
    const selected = path.join(clonePath, 'modules/selected lib');
    const unselected = path.join(clonePath, 'modules/unselected');
    if (config.withSubmodules === false) {
      expect(fs.existsSync(path.join(selected, '.git'))).toBe(false);
    } else {
      expect(runGit(selected, ['rev-parse', 'HEAD'])).toBe(expectedModule);
      expect(runGit(path.join(selected, 'nested'), ['rev-parse', 'HEAD'])).toBe(expectedNested);
      expect(fs.readFileSync(path.join(selected, 'nested/version.txt'), 'utf-8')).toBe('nested v2\n');
    }
    if (Array.isArray(config.submodules) || config.withSubmodules === false) {
      expect(fs.existsSync(path.join(unselected, '.git'))).toBe(false);
    } else {
      expect(runGit(unselected, ['rev-parse', 'HEAD'])).toBe(expectedModule);
    }
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(path.join(projectRepo, 'modules/selected lib'), ['rev-parse', 'HEAD'])).toBe(initialModule);
  });
});
