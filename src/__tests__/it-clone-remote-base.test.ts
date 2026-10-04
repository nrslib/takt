import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveGlobalConfig } from '../infra/config/global/globalConfig.js';
import { createSharedClone, createSharedCloneAbortable } from '../infra/task/clone.js';

const tempDirs: string[] = [];

afterEach(() => {
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
