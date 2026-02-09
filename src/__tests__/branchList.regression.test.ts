import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { getFilesChanged, getOriginalInstruction } from '../infra/task/branchList.js';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function isUnsupportedInitBranchOptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /unknown switch [`'-]?b/.test(error.message);
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): void {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  runGit(repo, ['add', fileName]);
  runGit(repo, ['commit', '-m', message]);
}

function setupRepoForIssue167(options?: { disableReflog?: boolean; firstBranchCommitMessage?: string }): { repoDir: string; branch: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'takt-branchlist-'));
  try {
    runGit(repoDir, ['init', '-b', 'main']);
  } catch (error) {
    if (!isUnsupportedInitBranchOptionError(error)) {
      throw error;
    }
    runGit(repoDir, ['init']);
  }
  if (options?.disableReflog) {
    runGit(repoDir, ['config', 'core.logallrefupdates', 'false']);
  }
  runGit(repoDir, ['config', 'user.name', 'takt-test']);
  runGit(repoDir, ['config', 'user.email', 'takt-test@example.com']);

  writeAndCommit(repoDir, 'main.txt', 'main\n', 'main base');
  runGit(repoDir, ['branch', '-M', 'main']);

  runGit(repoDir, ['checkout', '-b', 'develop']);
  writeAndCommit(repoDir, 'develop-a.txt', 'develop a\n', 'develop commit A');
  writeAndCommit(repoDir, 'develop-takt.txt', 'develop takt\n', 'takt: old instruction on develop');
  writeAndCommit(repoDir, 'develop-b.txt', 'develop b\n', 'develop commit B');

  const taktBranch = 'takt/#167/fix-original-instruction';
  runGit(repoDir, ['checkout', '-b', taktBranch]);
  const firstBranchCommitMessage = options?.firstBranchCommitMessage ?? 'takt: github-issue-167-fix-original-instruction';
  writeAndCommit(repoDir, 'task-1.txt', 'task1\n', firstBranchCommitMessage);
  writeAndCommit(repoDir, 'task-2.txt', 'task2\n', 'follow-up implementation');

  return { repoDir, branch: taktBranch };
}

describe('branchList regression for issue #167', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('should resolve originalInstruction correctly even when HEAD is main', () => {
    const fixture = setupRepoForIssue167();
    tempDirs.push(fixture.repoDir);
    runGit(fixture.repoDir, ['checkout', 'main']);

    const instruction = getOriginalInstruction(fixture.repoDir, 'main', fixture.branch);

    expect(instruction).toBe('github-issue-167-fix-original-instruction');
  });

  it('should keep filesChanged non-zero even when HEAD is target branch', () => {
    const fixture = setupRepoForIssue167();
    tempDirs.push(fixture.repoDir);
    runGit(fixture.repoDir, ['checkout', fixture.branch]);

    const changed = getFilesChanged(fixture.repoDir, 'main', fixture.branch);

    expect(changed).toBe(2);
  });

  it('should ignore takt commits that exist only on base branch history', () => {
    const fixture = setupRepoForIssue167();
    tempDirs.push(fixture.repoDir);
    runGit(fixture.repoDir, ['checkout', 'main']);

    const instruction = getOriginalInstruction(fixture.repoDir, 'main', fixture.branch);
    const changed = getFilesChanged(fixture.repoDir, 'main', fixture.branch);

    expect(instruction).toBe('github-issue-167-fix-original-instruction');
    expect(changed).toBe(2);
  });

  it('should keep original instruction and changed files after merging branch into develop', () => {
    const fixture = setupRepoForIssue167();
    tempDirs.push(fixture.repoDir);

    runGit(fixture.repoDir, ['checkout', 'develop']);
    runGit(fixture.repoDir, ['merge', '--no-ff', fixture.branch, '-m', 'merge takt branch']);
    runGit(fixture.repoDir, ['checkout', 'main']);

    const instruction = getOriginalInstruction(fixture.repoDir, 'main', fixture.branch);
    const changed = getFilesChanged(fixture.repoDir, 'main', fixture.branch);

    expect(instruction).toBe('github-issue-167-fix-original-instruction');
    expect(changed).toBe(2);
  });

  it('should resolve correctly without branch reflog by inferring base from refs', () => {
    const fixture = setupRepoForIssue167({ disableReflog: true });
    tempDirs.push(fixture.repoDir);
    runGit(fixture.repoDir, ['checkout', 'main']);

    const instruction = getOriginalInstruction(fixture.repoDir, 'main', fixture.branch);
    const changed = getFilesChanged(fixture.repoDir, 'main', fixture.branch);

    // Priority ref (main) resolves immediately without full ref scan (#191).
    // With main as base, the first takt commit found is from develop's history.
    expect(instruction).toBe('old instruction on develop');
    expect(changed).toBe(5);
  });

  it('should use inferred branch base when first branch commit has no takt prefix and reflog is unavailable', () => {
    const fixture = setupRepoForIssue167({
      disableReflog: true,
      firstBranchCommitMessage: 'Initial branch implementation',
    });
    tempDirs.push(fixture.repoDir);
    runGit(fixture.repoDir, ['checkout', 'main']);

    const instruction = getOriginalInstruction(fixture.repoDir, 'main', fixture.branch);

    // Priority ref (main) resolves immediately without full ref scan (#191).
    // With main as base, the first takt commit found is from develop's history.
    expect(instruction).toBe('old instruction on develop');
  });
});
