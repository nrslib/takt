import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { createSharedClone, createSharedCloneAbortable } from '../infra/task/clone.js';
import { saveProjectConfig } from '../infra/config/project/projectConfig.js';
import type { ProjectConfig } from '../infra/config/types.js';
import { getCloneMetaPath } from '../infra/task/clone-meta.js';
import * as cloneExec from '../infra/task/clone-exec.js';
import { assertTaskStateWorktreeOwnership } from '../features/tasks/taskStateWorktreeOwnership.js';
import { assertCentralWorktreeOwnership } from '../infra/task/centralWorktreeOwnership.js';
import { enqueueTaktTask } from '../features/mcp/operations.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { TaskRunner } from '../infra/task/runner.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, linkSync: vi.fn(original.linkSync) };
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

function createRemoteBaseProject() {
  const project = createProject();
  const { tempDir, projectRepo } = project;
  const remoteRepo = path.join(tempDir, 'origin.git');
  const updaterRepo = path.join(tempDir, 'updater');
  const baseBranch = 'goal/remote-base';
  runGit(tempDir, ['init', '--bare', '--quiet', '--initial-branch=main', remoteRepo]);
  runGit(projectRepo, ['remote', 'add', 'origin', remoteRepo]);
  runGit(projectRepo, ['push', '--quiet', '-u', 'origin', 'main']);
  const sourceHead = runGit(projectRepo, ['rev-parse', 'HEAD']);
  runGit(projectRepo, ['switch', '--quiet', '-c', baseBranch]);
  fs.writeFileSync(path.join(projectRepo, 'base.txt'), 'base v1\n');
  runGit(projectRepo, ['add', 'base.txt']);
  runGit(projectRepo, ['commit', '--quiet', '-m', 'base v1']);
  runGit(projectRepo, ['push', '--quiet', '-u', 'origin', baseBranch]);
  const localBase = runGit(projectRepo, ['rev-parse', 'HEAD']);
  runGit(projectRepo, ['switch', '--quiet', 'main']);

  runGit(tempDir, ['clone', '--quiet', '--branch', baseBranch, remoteRepo, updaterRepo]);
  runGit(updaterRepo, ['config', 'user.email', 'takt@example.com']);
  runGit(updaterRepo, ['config', 'user.name', 'TAKT Test']);
  fs.writeFileSync(path.join(updaterRepo, 'base.txt'), 'base v2\n');
  runGit(updaterRepo, ['commit', '--quiet', '-am', 'base v2']);
  runGit(updaterRepo, ['push', '--quiet', 'origin', baseBranch]);
  const remoteBase = runGit(updaterRepo, ['rev-parse', 'HEAD']);
  return { ...project, baseBranch, sourceHead, localBase, remoteBase };
}

const creators = [
  ['sync', createSharedClone],
  ['abortable', createSharedCloneAbortable],
] as const;

function createCollisionProject(branches: string[], location: 'local' | 'tracking' | 'origin') {
  vi.stubEnv('GIT_AUTHOR_DATE', '2026-10-10T00:00:00Z');
  vi.stubEnv('GIT_COMMITTER_DATE', '2026-10-10T00:00:00Z');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-clone-collision-'));
  tempDirs.push(tempDir);
  const projectRepo = path.join(tempDir, 'project');
  const clonePath = path.join(tempDir, 'task-clone');
  fs.mkdirSync(projectRepo);
  runGit(projectRepo, ['init', '--quiet', '--initial-branch=main']);
  runGit(projectRepo, ['config', 'user.email', 'takt@example.com']);
  runGit(projectRepo, ['config', 'user.name', 'TAKT Test']);
  const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {
    cwd: projectRepo, input: '', encoding: 'utf-8', stdio: 'pipe',
  }).trim();
  const baseHead = runGit(projectRepo, ['commit-tree', tree, '-m', 'base']);
  runGit(projectRepo, ['update-ref', 'refs/heads/main', baseHead]);
  const existing = branches.map((branch, index) => {
    const head = runGit(projectRepo, ['commit-tree', tree, '-p', baseHead, '-m', `existing ${index}`]);
    runGit(projectRepo, ['update-ref', `refs/heads/${branch}`, head]);
    return { branch, head };
  });
  const remoteRepo = path.join(tempDir, 'origin.git');
  if (location !== 'local') {
    runGit(tempDir, ['clone', '--quiet', '--bare', projectRepo, remoteRepo]);
    runGit(projectRepo, ['remote', 'add', 'origin', remoteRepo]);
    for (const { branch, head } of existing) {
      runGit(projectRepo, ['update-ref', '-d', `refs/heads/${branch}`]);
      if (location === 'tracking') {
        runGit(projectRepo, ['update-ref', `refs/remotes/origin/${branch}`, head]);
      }
    }
  }
  saveGlobalConfig({ language: 'en', autoFetch: false });
  return { projectRepo, clonePath, remoteRepo, baseHead, existing };
}

describe.each(creators)('generated branch collisions (%s)', (_mode, createClone) => {
  const candidate = 'takt/1465/fix-login-bug';

  it.each([
    ['upstream', 'none'], ['upstream', 'tracking'],
    ['origin and upstream', 'none'], ['origin and upstream', 'remote'],
  ] as const)('checks %s with a %s collision', async (remotes, collision) => {
    const project = createCollisionProject(collision === 'none' ? [] : [candidate], 'origin');
    runGit(project.projectRepo, ['remote', 'rename', 'origin', 'upstream']);
    if (collision === 'tracking') {
      runGit(project.remoteRepo, ['update-ref', '-d', `refs/heads/${candidate}`]);
      runGit(project.projectRepo, ['update-ref', `refs/remotes/upstream/${candidate}`, project.existing[0]!.head]);
    }
    if (remotes === 'origin and upstream') {
      const origin = path.join(path.dirname(project.projectRepo), 'empty-origin.git');
      runGit(project.projectRepo, ['init', '--bare', '--quiet', origin]);
      runGit(project.projectRepo, ['remote', 'add', 'origin', origin]);
    }
    expect(runGit(project.projectRepo, ['for-each-ref', '--format=%(refname)', `refs/heads/${candidate}`])).toBe('');
    if (collision !== 'tracking') {
      expect(runGit(project.projectRepo, ['for-each-ref', '--format=%(refname)', `refs/remotes/upstream/${candidate}`])).toBe('');
    }

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect(result.branch).toBe(collision === 'none' ? candidate : `${candidate}-2`);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(result.branch);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    if (collision !== 'none') {
      expect(runGit(collision === 'tracking' ? project.projectRepo : project.remoteRepo, [
        'rev-parse', collision === 'tracking' ? `refs/remotes/upstream/${candidate}` : `refs/heads/${candidate}`,
      ])).toBe(project.existing[0]!.head);
    }
    expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, result.branch), 'utf8'))).toEqual({
      branch: result.branch, clonePath: result.path,
    });
  });

  it.each([false, true])('checks upstream numbered candidates after publication conflict, occupied=%s', async (occupied) => {
    const alternate = `${candidate}-2`;
    const project = createCollisionProject(occupied ? [alternate] : [], 'origin');
    saveGlobalConfig({ language: 'en', autoFetch: false, worktreeDir: path.dirname(project.clonePath) });
    runGit(project.projectRepo, ['remote', 'rename', 'origin', 'upstream']);
    const metadata = getCloneMetaPath(project.projectRepo, candidate);
    const previousOwner = JSON.stringify({ branch: candidate, clonePath: '/previous-owner' });
    const { linkSync: link } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.linkSync).mockImplementationOnce((source, target) => {
      fs.writeFileSync(metadata, previousOwner);
      link(source, target);
    });

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect(result.branch).toBe(`${candidate}-${occupied ? 3 : 2}`);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(result.branch);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    expect(fs.readFileSync(metadata, 'utf8')).toBe(previousOwner);
    expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, result.branch), 'utf8'))).toEqual({
      branch: result.branch, clonePath: result.path,
    });
    if (occupied) expect(runGit(project.remoteRepo, ['rev-parse', `refs/heads/${alternate}`])).toBe(project.existing[0]!.head);
    const runner = new TaskRunner(project.projectRepo);
    const task = runner.addTask('fix-login-bug', { issue: 1465, slug: 'fix-login-bug' });
    runner.claimNextTasks(1);
    runner.updateRunningTaskExecution(task.name, { runSlug: 'remote-conflict', branch: result.branch, worktreePath: result.path });
    const restored = new TaskRunner(project.projectRepo).listTaskStateItems()[0]!;
    expect({ branch: restored.branch, path: restored.worktreePath }).toEqual({ branch: result.branch, path: result.path });
    expect(() => assertTaskStateWorktreeOwnership(project.projectRepo, restored)).not.toThrow();
  });

  it('preserves ownership of sequential independent clones without publishing their refs to the project', async () => {
    const project = createCollisionProject([], 'local');
    saveGlobalConfig({ language: 'en', autoFetch: false, worktreeDir: path.dirname(project.clonePath) });
    const options = { taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main' };
    const first = await createClone(project.projectRepo, { ...options, worktree: project.clonePath });
    const firstMetadata = fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch), 'utf8');
    const firstHead = runGit(first.path, ['rev-parse', 'HEAD']);
    expect(runGit(project.projectRepo, ['for-each-ref', '--format=%(refname)', `refs/heads/${candidate}`])).toBe('');

    const second = await createClone(project.projectRepo, { ...options, worktree: `${project.clonePath}-second` });

    expect.soft(first.branch).toBe(candidate);
    expect.soft(second.branch).toBe(`${candidate}-2`);
    expect.soft(fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch), 'utf8')).toBe(firstMetadata);
    expect(runGit(first.path, ['rev-parse', `refs/heads/${first.branch}`])).toBe(firstHead);
    for (const clone of [first, second]) {
      expect(runGit(clone.path, ['branch', '--show-current'])).toBe(clone.branch);
      expect(runGit(clone.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
      expect.soft(() => assertTaskStateWorktreeOwnership(project.projectRepo, {
        branch: clone.branch, worktreePath: clone.path,
      })).not.toThrow();
    }
  });

  it('keeps generated owners in the specified central metadata directory', async () => {
    const project = createCollisionProject([], 'local');
    const globalConfigDirectory = path.join(path.dirname(project.projectRepo), 'central');
    const stateId = 'test-state';
    const directory = path.join(globalConfigDirectory, 'state', 'projects', stateId, 'worktree-metadata');
    const options = {
      worktree: true, worktreeBaseDirectory: path.join(globalConfigDirectory, 'worktrees', stateId),
      cloneMetadataDirectory: directory, skipProjectLocalTaktSync: true,
      taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    };
    const first = await createClone(project.projectRepo, options);
    const firstMetadata = fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch, directory), 'utf8');

    const second = await createClone(project.projectRepo, options);

    expect(second.branch).toBe(`${candidate}-2`);
    expect(fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch, directory), 'utf8')).toBe(firstMetadata);
    for (const clone of [first, second]) {
      expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, clone.branch, directory), 'utf8'))).toEqual({
        branch: clone.branch, clonePath: clone.path,
      });
      expect(fs.existsSync(getCloneMetaPath(project.projectRepo, clone.branch))).toBe(false);
      expect(() => assertCentralWorktreeOwnership(project.projectRepo, globalConfigDirectory, stateId, {
        worktree: true, branch: clone.branch, worktreePath: clone.path,
      })).not.toThrow();
    }
  });

  it('skips unreadable ownership JSON without overwriting it', async () => {
    const project = createCollisionProject([], 'local');
    const metadata = getCloneMetaPath(project.projectRepo, candidate);
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    fs.writeFileSync(metadata, '{invalid JSON');

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect(result.branch).toBe(`${candidate}-2`);
    expect(fs.readFileSync(metadata, 'utf8')).toBe('{invalid JSON');
  });

  it.each(['fix-login-bug', ''])('avoids another clone owner for a fixed timestamp without an Issue and slug=%s', async (taskSlug) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const project = createCollisionProject([], 'local');
    const options = { taskSlug, baseBranch: 'main' };
    const first = await createClone(project.projectRepo, { ...options, worktree: project.clonePath });
    const metadata = fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch), 'utf8');

    const second = await createClone(project.projectRepo, { ...options, worktree: `${project.clonePath}-second` });

    expect(second.branch).toBe(`${first.branch}-2`);
    expect(fs.readFileSync(getCloneMetaPath(project.projectRepo, first.branch), 'utf8')).toBe(metadata);
    expect(runGit(first.path, ['branch', '--show-current'])).toBe(first.branch);
    expect(runGit(second.path, ['branch', '--show-current'])).toBe(second.branch);
  });

  it.each(['local', 'tracking', 'origin'] as const)('starts a new branch from base instead of reusing the %s candidate', async (location) => {
    const project = createCollisionProject([candidate], location);
    if (location === 'origin') {
      expect(() => runGit(project.projectRepo, ['show-ref', '--verify', `refs/remotes/origin/${candidate}`])).toThrow();
    }

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect(result.branch).not.toBe(candidate);
    expect(result.branch).toMatch(/^takt\/1465\//);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(result.branch);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    for (const { branch, head } of project.existing) {
      expect(runGit(location === 'local' ? project.projectRepo : project.remoteRepo, ['rev-parse', `refs/heads/${branch}`])).toBe(head);
    }
    expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, result.branch), 'utf-8'))).toEqual({
      branch: result.branch, clonePath: result.path,
    });
    expect(fs.existsSync(getCloneMetaPath(project.projectRepo, candidate))).toBe(false);
    expect(runGit(project.projectRepo, ['branch', '--show-current'])).toBe('main');
  });

  it('checks the alternate candidate too before starting a new branch', async () => {
    const alternate = `${candidate}-2`;
    const project = createCollisionProject([candidate, alternate], 'local');

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect([candidate, alternate]).not.toContain(result.branch);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(result.branch);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    for (const { branch, head } of project.existing) {
      expect(runGit(project.projectRepo, ['rev-parse', `refs/heads/${branch}`])).toBe(head);
    }
    expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, result.branch), 'utf-8'))).toEqual({
      branch: result.branch, clonePath: result.path,
    });
  });

  it.each(['fix-login-bug', ''])('avoids a timestamp-generated collision without an Issue for slug=%s', async (taskSlug) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const project = createCollisionProject([], 'local');
    const first = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug, baseBranch: 'main',
    });
    const baseTree = runGit(project.projectRepo, ['rev-parse', `${project.baseHead}^{tree}`]);
    const existingHead = runGit(project.projectRepo, ['commit-tree', baseTree, '-p', project.baseHead, '-m', 'existing timestamp branch']);
    runGit(project.projectRepo, ['update-ref', `refs/heads/${first.branch}`, existingHead]);

    const next = await createClone(project.projectRepo, {
      worktree: `${project.clonePath}-next`, taskSlug, baseBranch: 'main',
    });

    expect(next.branch).not.toBe(first.branch);
    expect(next.branch).not.toMatch(/^takt\/1465\//);
    expect(runGit(next.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    expect(runGit(project.projectRepo, ['rev-parse', `refs/heads/${first.branch}`])).toBe(existingHead);
    expect(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, next.branch), 'utf-8'))).toEqual({
      branch: next.branch, clonePath: next.path,
    });
  });

  it.each(['local', 'origin'] as const)('preserves an explicitly specified takt branch from %s', async (location) => {
    const project = createCollisionProject([candidate], location);

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, branch: candidate, baseBranch: 'main',
    });

    expect(result.branch).toBe(candidate);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(candidate);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.existing[0]!.head);
  });

  it('keeps the generated name when it is unused and origin is absent', async () => {
    const project = createCollisionProject([], 'local');

    const result = await createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    });

    expect(result.branch).toBe(candidate);
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
  });

  it('does not treat a later remote query failure as an unused generated name', async () => {
    const project = createCollisionProject([], 'origin');
    runGit(project.projectRepo, ['remote', 'add', 'upstream', path.join(project.projectRepo, 'missing-upstream.git')]);

    await expect(Promise.resolve().then(() => createClone(project.projectRepo, {
      worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
    }))).rejects.toThrow();

    expect(fs.existsSync(project.clonePath)).toBe(false);
    expect(fs.existsSync(getCloneMetaPath(project.projectRepo, candidate))).toBe(false);
  });
});

it('preserves both owners when two abortable creators select the same candidate before publication', async () => {
  const candidate = 'takt/1465/fix-login-bug';
  const project = createCollisionProject([], 'local');
  saveGlobalConfig({ language: 'en', autoFetch: false, worktreeDir: path.dirname(project.clonePath) });
  const runCommand = cloneExec.runGitCommandAbortable;
  const arrivals: string[] = [];
  const published = new Map<string, string>();
  const link = fs.linkSync;
  let publicationConflicts = 0;
  vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    try {
      link(source, target);
      published.set(String(target), fs.readFileSync(target, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') publicationConflicts++;
      throw error;
    }
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(cloneExec, 'runGitCommandAbortable').mockImplementation(async (cwd, args, signal) => {
    const result = await runCommand(cwd, args, signal);
    if (args[0] === 'checkout' && args[1] === '-b' && args[2] === candidate) {
      arrivals.push(cwd);
      if (arrivals.length === 2) release();
      await barrier;
    }
    return result;
  });
  const options = { taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main' };

  const clones = await Promise.all([
    createSharedCloneAbortable(project.projectRepo, { ...options, worktree: project.clonePath }),
    createSharedCloneAbortable(project.projectRepo, { ...options, worktree: `${project.clonePath}-second` }),
  ]);

  expect(arrivals).toHaveLength(2);
  expect(publicationConflicts).toBe(1);
  expect(published.size).toBe(2);
  expect.soft(new Set(clones.map((clone) => clone.branch))).toEqual(new Set([candidate, `${candidate}-2`]));
  expect(new Set(clones.map((clone) => clone.path)).size).toBe(2);
  for (const clone of clones) {
    expect(fs.readFileSync(getCloneMetaPath(project.projectRepo, clone.branch), 'utf8'))
      .toBe(published.get(getCloneMetaPath(project.projectRepo, clone.branch)));
    expect(runGit(clone.path, ['branch', '--show-current'])).toBe(clone.branch);
    expect(runGit(clone.path, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
    expect.soft(JSON.parse(fs.readFileSync(getCloneMetaPath(project.projectRepo, clone.branch), 'utf8'))).toEqual({
      branch: clone.branch, clonePath: clone.path,
    });
    expect.soft(() => assertTaskStateWorktreeOwnership(project.projectRepo, {
      branch: clone.branch, worktreePath: clone.path,
    })).not.toThrow();
  }
  const runner = new TaskRunner(project.projectRepo);
  for (const _clone of clones) runner.addTask('fix-login-bug', { issue: 1465, slug: 'fix-login-bug' });
  const tasks = runner.claimNextTasks(2);
  for (const [index, clone] of clones.entries()) {
    runner.updateRunningTaskExecution(tasks[index]!.name, {
      runSlug: `parallel-${index}`, branch: clone.branch, worktreePath: clone.path,
    });
  }
  const restored = new TaskRunner(project.projectRepo).listTaskStateItems();
  expect(restored.map((task) => ({ branch: task.branch, path: task.worktreePath })))
    .toEqual(clones.map((clone) => ({ branch: clone.branch, path: clone.path })));
  for (const task of restored) expect(() => assertTaskStateWorktreeOwnership(project.projectRepo, task)).not.toThrow();
});

it('propagates cancellation during generated-name queries without creating a clone or metadata', async () => {
  const candidate = 'takt/1465/fix-login-bug';
  const project = createCollisionProject([], 'origin');
  runGit(project.projectRepo, ['remote', 'add', 'upstream', project.remoteRepo]);
  const controller = new AbortController();
  const runGitCommand = cloneExec.runGitCommandAbortable;
  const query = vi.spyOn(cloneExec, 'runGitCommandAbortable').mockImplementation(async (cwd, args, signal) => {
    if (args[0] === 'ls-remote' && args[2] === 'upstream') controller.abort();
    return runGitCommand(cwd, args, signal);
  });

  await expect(createSharedCloneAbortable(project.projectRepo, {
    worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
  }, controller.signal)).rejects.toThrow('Task execution aborted');

  expect(query).toHaveBeenCalledWith(project.projectRepo, [
    'ls-remote', '--heads', 'upstream', `refs/heads/${candidate}`,
  ], controller.signal);
  expect(fs.existsSync(project.clonePath)).toBe(false);
  expect(fs.existsSync(getCloneMetaPath(project.projectRepo, candidate))).toBe(false);
  expect(runGit(project.projectRepo, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
});

it('cancels an upstream query after publication conflict without renaming or republishing', async () => {
  const candidate = 'takt/1465/fix-login-bug';
  const project = createCollisionProject([], 'origin');
  runGit(project.projectRepo, ['remote', 'add', 'upstream', project.remoteRepo]);
  const metadata = getCloneMetaPath(project.projectRepo, candidate);
  const previousOwner = JSON.stringify({ branch: candidate, clonePath: '/previous-owner' });
  const controller = new AbortController();
  const { linkSync: link } = await vi.importActual<typeof import('node:fs')>('node:fs');
  const publication = vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, target) => {
    fs.writeFileSync(metadata, previousOwner);
    link(source, target);
  });
  const runCommand = cloneExec.runGitCommandAbortable;
  const query = vi.spyOn(cloneExec, 'runGitCommandAbortable').mockImplementation(async (cwd, args, signal) => {
    if (args[0] === 'ls-remote' && args[2] === 'upstream' && args[3] === `refs/heads/${candidate}-2`) controller.abort();
    return runCommand(cwd, args, signal);
  });

  await expect(createSharedCloneAbortable(project.projectRepo, {
    worktree: project.clonePath, taskSlug: 'fix-login-bug', issueNumber: 1465, baseBranch: 'main',
  }, controller.signal)).rejects.toThrow();

  expect(query).toHaveBeenCalledWith(project.projectRepo, [
    'ls-remote', '--heads', 'upstream', `refs/heads/${candidate}-2`,
  ], controller.signal);
  expect(query.mock.calls.map((call) => call[1])).not.toContainEqual(expect.arrayContaining(['branch', '-m']));
  expect(publication).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(metadata, 'utf8')).toBe(previousOwner);
  expect(fs.existsSync(getCloneMetaPath(project.projectRepo, `${candidate}-2`))).toBe(false);
  expect(runGit(project.clonePath, ['branch', '--show-current'])).toBe(candidate);
});

it('executes two MCP tasks for the same Issue and slug with independent persisted ownership', async () => {
  const project = createCollisionProject([], 'local');
  saveGlobalConfig({ language: 'en', autoFetch: false, branchNameStrategy: 'romaji', worktreeDir: path.dirname(project.clonePath) });
  const input = {
    cwd: project.projectRepo, task: 'fix-login-bug', workflow: 'default',
    autoPr: false, issue: { number: 1465 }, taskContext: { baseBranch: 'main' },
  };
  const first = await enqueueTaktTask(input);
  const second = await enqueueTaktTask(input);
  expect(first.isError).toBeUndefined();
  expect(second.isError).toBeUndefined();
  const runner = new TaskRunner(project.projectRepo);
  expect(runner.listTaskStateItems().map((task) => task.issueNumber)).toEqual([1465, 1465]);
  const tasks = runner.claimNextTasks(2);
  expect(tasks.map((task) => task.slug)).toEqual(['fix-login-bug', 'fix-login-bug']);
  for (const task of tasks) {
    const resolved = await resolveTaskExecution(task, project.projectRepo, undefined, { outputMode: 'silent' });
    runner.updateRunningTaskExecution(task.name, {
      runSlug: resolved.reportDirName, branch: resolved.branch, worktreePath: resolved.worktreePath,
    });
  }

  const restored = new TaskRunner(project.projectRepo).listTaskStateItems();

  expect(restored.map((task) => task.branch)).toEqual(['takt/1465/fix-login-bug', 'takt/1465/fix-login-bug-2']);
  expect(new Set(restored.map((task) => task.worktreePath)).size).toBe(2);
  for (const task of restored) {
    expect(() => assertTaskStateWorktreeOwnership(project.projectRepo, task)).not.toThrow();
    expect(runGit(task.worktreePath!, ['branch', '--show-current'])).toBe(task.branch);
    expect(runGit(task.worktreePath!, ['rev-parse', 'HEAD'])).toBe(project.baseHead);
  }
  expect(() => assertTaskStateWorktreeOwnership(project.projectRepo, {
    ...restored[0]!, worktreePath: restored[1]!.worktreePath,
  })).toThrow();
});

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

describe.each(creators)('shared clone base selection (%s)', (_mode, createClone) => {
  const fetchModes = [
    ['disabled', false],
    ['unavailable', true],
  ] as const;

  it.each(fetchModes)('uses the cached remote-only base when fetching is %s', async (_fetchMode, autoFetch) => {
    const { tempDir, projectRepo, clonePath, baseBranch, sourceHead, localBase, remoteBase } = createRemoteBaseProject();
    runGit(projectRepo, ['branch', '-D', baseBranch]);
    if (autoFetch) {
      runGit(projectRepo, ['remote', 'set-url', 'origin', path.join(tempDir, 'unavailable-origin.git')]);
    }
    expect(localBase).not.toBe(sourceHead);
    expect(localBase).not.toBe(remoteBase);
    expect(runGit(projectRepo, ['rev-parse', `refs/remotes/origin/${baseBranch}`])).toBe(localBase);
    expect(() => runGit(projectRepo, ['show-ref', '--verify', `refs/heads/${baseBranch}`])).toThrow();
    saveGlobalConfig({ language: 'en', autoFetch });
    const branch = 'feature/new-task';

    const result = await createClone(projectRepo, { worktree: clonePath, taskSlug: 'cached-base', branch, baseBranch });

    expect(result).toMatchObject({ path: clonePath, branch });
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(localBase);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(branch);
    expect(fs.readFileSync(path.join(result.path, 'base.txt'), 'utf-8')).toBe('base v1\n');
    expect(runGit(result.path, ['remote'])).toBe('');
    expect(() => runGit(projectRepo, ['show-ref', '--verify', `refs/heads/${baseBranch}`])).toThrow();
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(projectRepo, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(runGit(projectRepo, ['rev-parse', `refs/remotes/origin/${baseBranch}`])).toBe(localBase);
  });

  it.each(fetchModes)('prefers the local base over a different tracking ref when fetching is %s', async (_fetchMode, autoFetch) => {
    const { tempDir, projectRepo, clonePath, baseBranch, sourceHead, localBase, remoteBase } = createRemoteBaseProject();
    runGit(projectRepo, ['fetch', '--quiet', 'origin']);
    if (autoFetch) {
      runGit(projectRepo, ['remote', 'set-url', 'origin', path.join(tempDir, 'unavailable-origin.git')]);
    }
    expect(localBase).not.toBe(sourceHead);
    expect(localBase).not.toBe(remoteBase);
    expect(runGit(projectRepo, ['rev-parse', `refs/heads/${baseBranch}`])).toBe(localBase);
    expect(runGit(projectRepo, ['rev-parse', `refs/remotes/origin/${baseBranch}`])).toBe(remoteBase);
    saveGlobalConfig({ language: 'en', autoFetch });
    const branch = 'feature/new-task';

    const result = await createClone(projectRepo, { worktree: clonePath, taskSlug: 'local-base', branch, baseBranch });

    expect(result).toMatchObject({ path: clonePath, branch });
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(localBase);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(branch);
    expect(fs.readFileSync(path.join(result.path, 'base.txt'), 'utf-8')).toBe('base v1\n');
    expect(runGit(projectRepo, ['rev-parse', `refs/heads/${baseBranch}`])).toBe(localBase);
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(projectRepo, ['rev-parse', 'HEAD'])).toBe(sourceHead);
  });

  it('uses the latest fetched base even when a stale local base exists', async () => {
    const { projectRepo, clonePath, baseBranch, sourceHead, localBase, remoteBase } = createRemoteBaseProject();
    expect(localBase).not.toBe(remoteBase);
    expect(runGit(projectRepo, ['rev-parse', `refs/heads/${baseBranch}`])).toBe(localBase);
    expect(runGit(projectRepo, ['rev-parse', `refs/remotes/origin/${baseBranch}`])).toBe(localBase);
    saveGlobalConfig({ language: 'en', autoFetch: true });
    const branch = 'feature/new-task';

    const result = await createClone(projectRepo, { worktree: clonePath, taskSlug: 'fetched-base', branch, baseBranch });

    expect(result).toMatchObject({ path: clonePath, branch });
    expect(runGit(result.path, ['rev-parse', 'HEAD'])).toBe(remoteBase);
    expect(runGit(result.path, ['branch', '--show-current'])).toBe(branch);
    expect(fs.readFileSync(path.join(result.path, 'base.txt'), 'utf-8')).toBe('base v2\n');
    expect(runGit(projectRepo, ['rev-parse', `refs/heads/${baseBranch}`])).toBe(localBase);
    expect(runGit(projectRepo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(projectRepo, ['rev-parse', 'HEAD'])).toBe(sourceHead);
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
