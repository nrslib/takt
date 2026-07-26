import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSharedClone } from '../infra/task/clone.js';
import { materializePullRequestBase } from '../infra/task/git.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-clone-isolation-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function runGit(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function createSourceRepo(tempDir: string): string {
  const repoDir = path.join(tempDir, 'source-main-repository');
  fs.mkdirSync(repoDir);
  runGit(repoDir, ['init', '--quiet']);
  runGit(repoDir, ['config', 'user.email', 'takt@example.com']);
  runGit(repoDir, ['config', 'user.name', 'TAKT Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'initial\n');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['commit', '--quiet', '-m', 'initial']);
  return repoDir;
}

function rewriteGitFileToRelativeGitdir(worktreeDir: string): void {
  const gitFile = path.join(worktreeDir, '.git');
  const prefix = 'gitdir: ';
  const content = fs.readFileSync(gitFile, 'utf-8').trim();
  if (!content.startsWith(prefix)) {
    throw new Error(`Unexpected linked worktree .git file: ${content}`);
  }

  const gitdir = content.slice(prefix.length);
  const absoluteGitdir = path.isAbsolute(gitdir)
    ? gitdir
    : path.resolve(worktreeDir, gitdir);
  fs.writeFileSync(
    gitFile,
    `${prefix}${path.relative(fs.realpathSync(worktreeDir), fs.realpathSync(absoluteGitdir))}\n`,
  );
}

function filesContaining(rootDir: string, needle: string): string[] {
  const matches: string[] = [];
  const needleBuffer = Buffer.from(needle);

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(entryPath);
        continue;
      }
      if (entry.isFile() && fs.readFileSync(entryPath).includes(needleBuffer)) {
        matches.push(path.relative(rootDir, entryPath));
      }
    }
  }

  scan(rootDir);
  return matches.sort();
}

describe('shared clone generated metadata isolation', () => {
  it('materializes the latest custom PR base and remote head into exact isolated refs', () => {
    const tempDir = createTempDir();
    const remoteRepo = path.join(tempDir, 'origin.git');
    const projectRepo = path.join(tempDir, 'project');
    const updaterRepo = path.join(tempDir, 'base-updater');
    const clonePath = path.join(tempDir, 'pr-clone');
    const baseBranch = 'release/custom';
    const headBranch = 'feature/pr-head';

    runGit(tempDir, ['init', '--bare', '--quiet', remoteRepo]);
    runGit(tempDir, ['clone', '--quiet', remoteRepo, projectRepo]);
    runGit(projectRepo, ['config', 'user.email', 'takt@example.com']);
    runGit(projectRepo, ['config', 'user.name', 'TAKT Test']);
    runGit(projectRepo, ['switch', '--quiet', '-c', 'main']);
    fs.writeFileSync(path.join(projectRepo, 'README.md'), 'initial\n');
    runGit(projectRepo, ['add', 'README.md']);
    runGit(projectRepo, ['commit', '--quiet', '-m', 'initial']);
    runGit(projectRepo, ['push', '--quiet', '-u', 'origin', 'main']);

    runGit(projectRepo, ['switch', '--quiet', '-c', baseBranch]);
    fs.writeFileSync(path.join(projectRepo, 'base.txt'), 'base v1\n');
    runGit(projectRepo, ['add', 'base.txt']);
    runGit(projectRepo, ['commit', '--quiet', '-m', 'base v1']);
    runGit(projectRepo, ['push', '--quiet', '-u', 'origin', baseBranch]);
    const staleLocalBase = runGit(projectRepo, ['rev-parse', `refs/heads/${baseBranch}`]).toString().trim();

    runGit(projectRepo, ['switch', '--quiet', '-c', headBranch]);
    fs.writeFileSync(path.join(projectRepo, 'head.txt'), 'head\n');
    runGit(projectRepo, ['add', 'head.txt']);
    runGit(projectRepo, ['commit', '--quiet', '-m', 'head']);
    runGit(projectRepo, ['push', '--quiet', '-u', 'origin', headBranch]);
    const expectedHead = runGit(projectRepo, ['rev-parse', `refs/heads/${headBranch}`]).toString().trim();
    runGit(projectRepo, ['switch', '--quiet', 'main']);

    runGit(tempDir, ['clone', '--quiet', remoteRepo, updaterRepo]);
    runGit(updaterRepo, ['config', 'user.email', 'takt@example.com']);
    runGit(updaterRepo, ['config', 'user.name', 'TAKT Test']);
    runGit(updaterRepo, ['switch', '--quiet', baseBranch]);
    fs.writeFileSync(path.join(updaterRepo, 'base.txt'), 'base v2\n');
    runGit(updaterRepo, ['commit', '--quiet', '-am', 'base v2']);
    runGit(updaterRepo, ['push', '--quiet', 'origin', baseBranch]);
    const expectedBase = runGit(updaterRepo, ['rev-parse', 'HEAD']).toString().trim();
    expect(staleLocalBase).not.toBe(expectedBase);

    const result = createSharedClone(projectRepo, {
      worktree: clonePath,
      taskSlug: 'pr-custom-base',
      branch: headBranch,
      baseBranch,
      pullRequestBaseBranch: baseBranch,
    });

    expect(result).toMatchObject({
      path: clonePath,
      branch: headBranch,
      pullRequestBaseRef: `refs/takt/pr-base/${baseBranch}`,
      pullRequestHeadRef: `refs/heads/${headBranch}`,
    });
    expect(runGit(clonePath, ['rev-parse', result.pullRequestBaseRef!]).toString().trim()).toBe(expectedBase);
    expect(runGit(clonePath, ['rev-parse', result.pullRequestHeadRef!]).toString().trim()).toBe(expectedHead);
    expect(() => runGit(
      clonePath,
      ['diff', '--stat', `${result.pullRequestBaseRef}...${result.pullRequestHeadRef}`],
    )).not.toThrow();

    runGit(clonePath, ['update-ref', '-d', result.pullRequestBaseRef!]);
    expect(materializePullRequestBase(projectRepo, clonePath, baseBranch)).toBe(
      `refs/takt/pr-base/${baseBranch}`,
    );
    expect(runGit(clonePath, ['rev-parse', result.pullRequestBaseRef!]).toString().trim()).toBe(expectedBase);

    expect(materializePullRequestBase(projectRepo, projectRepo, baseBranch)).toBe(
      `refs/takt/pr-base/${baseBranch}`,
    );
    expect(
      runGit(projectRepo, ['rev-parse', `refs/takt/pr-base/${baseBranch}`]).toString().trim(),
    ).toBe(expectedBase);
  });

  it('does not leave the source repo path in clone .git metadata for local branch clones', () => {
    const tempDir = createTempDir();
    const sourceRepo = createSourceRepo(tempDir);
    const clonePath = path.join(tempDir, 'local-branch-clone');

    runGit(sourceRepo, ['branch', 'feature/local-only']);

    createSharedClone(sourceRepo, {
      worktree: clonePath,
      taskSlug: 'local-isolation',
      branch: 'feature/local-only',
    });

    expect(filesContaining(path.join(clonePath, '.git'), sourceRepo)).toEqual([]);
  });

  it('does not leave the source repo path in clone .git metadata for remote tracking branch fetches', () => {
    const tempDir = createTempDir();
    const sourceRepo = createSourceRepo(tempDir);
    const clonePath = path.join(tempDir, 'remote-branch-clone');
    const branch = 'feature/remote-only';

    runGit(sourceRepo, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD']);

    createSharedClone(sourceRepo, {
      worktree: clonePath,
      taskSlug: 'remote-isolation',
      branch,
    });

    expect(filesContaining(path.join(clonePath, '.git'), sourceRepo)).toEqual([]);
    expect(fs.existsSync(path.join(clonePath, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('clones a real linked worktree with a relative gitdir without exposing source paths in clone metadata', () => {
    const tempDir = createTempDir();
    const sourceRepo = createSourceRepo(tempDir);
    const linkedWorktree = path.join(tempDir, 'linked-worktree');
    const clonePath = path.join(tempDir, 'linked-worktree-clone');
    const branch = 'feature/linked-worktree-source';

    runGit(sourceRepo, ['worktree', 'add', '--quiet', '-b', branch, linkedWorktree, 'HEAD']);
    rewriteGitFileToRelativeGitdir(linkedWorktree);

    expect(process.cwd()).not.toBe(sourceRepo);
    expect(process.cwd()).not.toBe(path.dirname(linkedWorktree));
    createSharedClone(linkedWorktree, {
      worktree: clonePath,
      taskSlug: 'linked-worktree-isolation',
      branch,
    });

    const cloneGitDir = path.join(clonePath, '.git');
    expect(filesContaining(cloneGitDir, sourceRepo)).toEqual([]);
    expect(filesContaining(cloneGitDir, linkedWorktree)).toEqual([]);
    expect(filesContaining(cloneGitDir, tempDir)).toEqual([]);
    expect(fs.existsSync(path.join(cloneGitDir, 'FETCH_HEAD'))).toBe(false);
  });
});
