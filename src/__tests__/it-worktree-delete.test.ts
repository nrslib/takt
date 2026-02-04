/**
 * Integration test for worktree branch deletion
 *
 * Tests that worktree branches can be properly deleted,
 * including cleanup of worktree directory and session file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { listTaktBranches } from '../infra/task/branchList.js';
import { deleteBranch } from '../features/tasks/list/taskActions.js';

describe('worktree branch deletion', () => {
  let testDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    // Create temporary git repository
    testDir = join(tmpdir(), `takt-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Initialize git repo
    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

    // Create initial commit
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

    // Create .takt directory structure
    const taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    mkdirSync(join(taktDir, 'worktree-sessions'), { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (worktreeDir && existsSync(worktreeDir)) {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should delete worktree branch and cleanup files', () => {
    // Create worktree
    const branchSlug = '20260203T1000-test-deletion';
    worktreeDir = join(tmpdir(), branchSlug);
    execFileSync('git', ['clone', '--shared', testDir, worktreeDir]);

    // Configure git user in worktree (shared clones don't inherit config)
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });

    const branchName = `takt/${branchSlug}`;
    execFileSync('git', ['checkout', '-b', branchName], { cwd: worktreeDir });

    // Make a change
    writeFileSync(join(worktreeDir, 'test.txt'), 'test content');
    execFileSync('git', ['add', 'test.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-m', 'Test change'], { cwd: worktreeDir });

    // Create worktree-session file
    const resolvedPath = resolve(worktreeDir);
    const sessionFilename = resolvedPath.replace(/[/\\:]/g, '-') + '.json';
    const sessionPath = join(testDir, '.takt', 'worktree-sessions', sessionFilename);
    const sessionData = {
      agentSessions: {},
      updatedAt: new Date().toISOString(),
      provider: 'claude',
    };
    writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));

    // Verify branch is listed
    const branchesBefore = listTaktBranches(testDir);
    const foundBefore = branchesBefore.find(b => b.branch === branchName);
    expect(foundBefore).toBeDefined();
    expect(foundBefore?.worktreePath).toBe(worktreeDir);

    // Verify worktree directory and session file exist
    expect(existsSync(worktreeDir)).toBe(true);
    expect(existsSync(sessionPath)).toBe(true);

    // Delete branch
    const result = deleteBranch(testDir, {
      info: foundBefore!,
      filesChanged: 1,
      taskSlug: branchSlug,
      originalInstruction: 'Test instruction',
    });

    // Verify deletion succeeded
    expect(result).toBe(true);

    // Verify worktree directory was removed
    expect(existsSync(worktreeDir)).toBe(false);

    // Verify session file was removed
    expect(existsSync(sessionPath)).toBe(false);

    // Verify branch is no longer listed
    const branchesAfter = listTaktBranches(testDir);
    const foundAfter = branchesAfter.find(b => b.branch === branchName);
    expect(foundAfter).toBeUndefined();
  });

  it('should handle deletion when worktree directory is already deleted', () => {
    // Create worktree
    const branchSlug = '20260203T1001-already-deleted';
    worktreeDir = join(tmpdir(), branchSlug);
    execFileSync('git', ['clone', '--shared', testDir, worktreeDir]);

    // Configure git user in worktree (shared clones don't inherit config)
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });

    const branchName = `takt/${branchSlug}`;
    execFileSync('git', ['checkout', '-b', branchName], { cwd: worktreeDir });

    // Create worktree-session file
    const resolvedPath = resolve(worktreeDir);
    const sessionFilename = resolvedPath.replace(/[/\\:]/g, '-') + '.json';
    const sessionPath = join(testDir, '.takt', 'worktree-sessions', sessionFilename);
    const sessionData = {
      agentSessions: {},
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));

    // Manually delete worktree directory before deletion
    rmSync(worktreeDir, { recursive: true, force: true });

    // Delete branch (should not fail even though worktree is gone)
    const result = deleteBranch(testDir, {
      info: {
        branch: branchName,
        commit: 'worktree',
        worktreePath: worktreeDir,
      },
      filesChanged: 0,
      taskSlug: branchSlug,
      originalInstruction: 'Test instruction',
    });

    // Verify deletion succeeded
    expect(result).toBe(true);

    // Verify session file was still removed
    expect(existsSync(sessionPath)).toBe(false);
  });

  it('should delete regular (non-worktree) branches normally', () => {
    const defaultBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    // Create a regular local branch
    const branchName = 'takt/20260203T1002-regular-branch';
    execFileSync('git', ['checkout', '-b', branchName], { cwd: testDir });

    // Make a change
    writeFileSync(join(testDir, 'test.txt'), 'test content');
    execFileSync('git', ['add', 'test.txt'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Test change'], { cwd: testDir });

    // Switch back to main
    execFileSync('git', ['checkout', defaultBranch || 'main'], { cwd: testDir });

    // Verify branch exists
    const branchesBefore = listTaktBranches(testDir);
    const foundBefore = branchesBefore.find(b => b.branch === branchName);
    expect(foundBefore).toBeDefined();
    expect(foundBefore?.worktreePath).toBeUndefined();

    // Delete branch
    const result = deleteBranch(testDir, {
      info: foundBefore!,
      filesChanged: 1,
      taskSlug: '20260203T1002-regular-branch',
      originalInstruction: 'Test instruction',
    });

    // Verify deletion succeeded
    expect(result).toBe(true);

    // Verify branch is no longer listed
    const branchesAfter = listTaktBranches(testDir);
    const foundAfter = branchesAfter.find(b => b.branch === branchName);
    expect(foundAfter).toBeUndefined();
  });
});
