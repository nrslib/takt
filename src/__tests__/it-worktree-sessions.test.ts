/**
 * Integration test for worktree-sessions recognition in takt list
 *
 * Tests that branches created in isolated worktrees (shared clones)
 * are properly recognized by `takt list` through worktree-sessions tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { listTaktBranches } from '../infra/task/branchList.js';

describe('worktree-sessions recognition', () => {
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

  it('should recognize branches from worktree-sessions', () => {
    // Simulate worktree creation (directory name includes timestamp-slug)
    const branchSlug = '20260203T0900-test-feature';
    worktreeDir = join(tmpdir(), branchSlug);

    // Create shared clone
    execFileSync('git', ['clone', '--shared', testDir, worktreeDir]);

    // Configure git user in worktree (shared clones don't inherit config)
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });

    // Create and checkout takt branch in worktree
    const branchName = `takt/${branchSlug}`;
    execFileSync('git', ['checkout', '-b', branchName], { cwd: worktreeDir });

    // Make a change
    writeFileSync(join(worktreeDir, 'test.txt'), 'test content');
    execFileSync('git', ['add', 'test.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-m', 'Test change'], { cwd: worktreeDir });

    // Create worktree-session file (using same encoding as encodeWorktreePath)
    const resolvedPath = resolve(worktreeDir);
    const sessionFilename = resolvedPath.replace(/[/\\:]/g, '-') + '.json';
    const sessionPath = join(testDir, '.takt', 'worktree-sessions', sessionFilename);
    const sessionData = {
      agentSessions: {},
      updatedAt: new Date().toISOString(),
      provider: 'claude',
    };
    writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));

    // Test: listTaktBranches should find the worktree branch
    const branches = listTaktBranches(testDir);

    expect(branches.length).toBeGreaterThan(0);
    const found = branches.find(b => b.branch === branchName);
    expect(found).toBeDefined();
    expect(found?.worktreePath).toBe(worktreeDir);
  });

  it('should skip worktree-sessions when worktree directory is deleted', () => {
    // Create worktree-session file for non-existent directory
    worktreeDir = '/nonexistent/path/20260203T0900-test';
    const resolvedPath = resolve(worktreeDir);
    const sessionFilename = resolvedPath.replace(/[/\\:]/g, '-') + '.json';
    const sessionPath = join(testDir, '.takt', 'worktree-sessions', sessionFilename);
    const sessionData = {
      agentSessions: {},
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));

    // Test: listTaktBranches should not include the non-existent worktree
    const branches = listTaktBranches(testDir);

    const found = branches.find(b => b.worktreePath === worktreeDir);
    expect(found).toBeUndefined();
  });

  it('should extract correct branch name from session filename', () => {
    // Create worktree (directory name includes timestamp-slug)
    const branchSlug = '20260203T0851-unify-debug-log';
    worktreeDir = join(tmpdir(), branchSlug);
    execFileSync('git', ['clone', '--shared', testDir, worktreeDir]);

    // Configure git user in worktree (shared clones don't inherit config)
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });

    const branchName = `takt/${branchSlug}`;
    execFileSync('git', ['checkout', '-b', branchName], { cwd: worktreeDir });

    // Create session file with proper path encoding
    const resolvedPath = resolve(worktreeDir);
    const sessionFilename = resolvedPath.replace(/[/\\:]/g, '-') + '.json';
    const sessionPath = join(testDir, '.takt', 'worktree-sessions', sessionFilename);
    const sessionData = {
      agentSessions: {},
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));

    const branches = listTaktBranches(testDir);

    const found = branches.find(b => b.branch === branchName);
    expect(found).toBeDefined();
    expect(found?.worktreePath).toBe(worktreeDir);
  });
});
