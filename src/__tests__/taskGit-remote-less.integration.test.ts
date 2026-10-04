import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishTaskBranch } from '../infra/task/git.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function configureRepository(cwd: string): void {
  git(cwd, ['config', 'user.name', 'TAKT test']);
  git(cwd, ['config', 'user.email', 'takt-test@example.test']);
}

describe('remote-less shared clone branch publication', () => {
  let rootDir: string;
  let projectDir: string;
  let originDir: string;
  let cloneDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'takt-remote-less-'));
    projectDir = join(rootDir, 'project');
    originDir = join(rootDir, 'origin.git');
    cloneDir = join(rootDir, 'clone');

    git(rootDir, ['init', '--bare', originDir]);
    git(rootDir, ['init', projectDir]);
    configureRepository(projectDir);
    git(projectDir, ['checkout', '-b', 'main']);
    writeFileSync(join(projectDir, 'README.md'), 'base\n', 'utf-8');
    git(projectDir, ['add', 'README.md']);
    git(projectDir, ['commit', '-m', 'base']);
    git(projectDir, ['remote', 'add', 'origin', originDir]);
    git(projectDir, ['push', '-u', 'origin', 'main']);

    git(rootDir, ['clone', projectDir, cloneDir]);
    configureRepository(cloneDir);
    git(cloneDir, ['remote', 'remove', 'origin']);
    git(cloneDir, ['checkout', '-b', 'takt/failed-task']);
    writeFileSync(join(cloneDir, 'result.txt'), 'failed-run fix\n', 'utf-8');
    git(cloneDir, ['add', 'result.txt']);
    git(cloneDir, ['commit', '-m', 'failed run fix']);
  });

  it('projectCwd fetches the clone branch and pushes that same branch to origin', () => {
    const cloneTip = git(cloneDir, ['rev-parse', 'takt/failed-task']);

    publishTaskBranch(cloneDir, projectDir, 'takt/failed-task');

    expect(git(projectDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toBe(cloneTip);
    expect(git(originDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toBe(cloneTip);
    expect(readFileSync(join(cloneDir, 'result.txt'), 'utf-8')).toBe('failed-run fix\n');
  });

  it('named remoteへ直接pushし、projectCwd relayを使わない', () => {
    git(cloneDir, ['remote', 'add', 'upstream', originDir]);
    const cloneTip = git(cloneDir, ['rev-parse', 'takt/failed-task']);

    publishTaskBranch(cloneDir, projectDir, 'takt/failed-task');

    expect(git(originDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toBe(cloneTip);
    expect(() => git(projectDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toThrow();
  });

  it('remoteありの直接push失敗時はrelayへフォールバックしない', () => {
    git(cloneDir, ['remote', 'add', 'upstream', join(rootDir, 'missing.git')]);

    expect(() => publishTaskBranch(cloneDir, projectDir, 'takt/failed-task')).toThrow();
    expect(() => git(projectDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toThrow();
  });

  it('複数のnon-origin remoteがある場合は公開先を推測しない', () => {
    git(cloneDir, ['remote', 'add', 'upstream', originDir]);
    git(cloneDir, ['remote', 'add', 'backup', originDir]);

    expect(() => publishTaskBranch(cloneDir, projectDir, 'takt/failed-task'))
      .toThrow('multiple remotes configured');
    expect(() => git(originDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toThrow();
    expect(() => git(projectDir, ['rev-parse', 'refs/heads/takt/failed-task'])).toThrow();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
});
