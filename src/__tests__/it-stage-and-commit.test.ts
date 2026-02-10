/**
 * Integration test for stageAndCommit
 *
 * Tests that gitignored files are NOT included in commits.
 * Regression test for c89ac4c where `git add -f .takt/runs/` caused
 * gitignored report files to be committed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { stageAndCommit } from '../infra/task/git.js';

describe('stageAndCommit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });

    // Initial commit
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should not commit gitignored .takt/runs/ files', () => {
    // Setup: .takt/ is gitignored
    writeFileSync(join(testDir, '.gitignore'), '.takt/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'Add gitignore'], { cwd: testDir });

    // Create .takt/runs/ with a report file
    mkdirSync(join(testDir, '.takt', 'runs', 'test-report', 'reports'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'runs', 'test-report', 'reports', '00-plan.md'), '# Plan');

    // Also create a tracked file change to ensure commit happens
    writeFileSync(join(testDir, 'src.ts'), 'export const x = 1;');

    const hash = stageAndCommit(testDir, 'test commit');
    expect(hash).toBeDefined();

    // Verify .takt/runs/ is NOT in the commit
    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toContain('src.ts');
    expect(committedFiles).not.toContain('.takt/runs/');
  });

  it('should commit normally when no gitignored files exist', () => {
    writeFileSync(join(testDir, 'app.ts'), 'console.log("hello");');

    const hash = stageAndCommit(testDir, 'add app');
    expect(hash).toBeDefined();

    const committedFiles = execFileSync('git', ['diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    expect(committedFiles).toBe('app.ts');
  });

  it('should return undefined when there are no changes', () => {
    const hash = stageAndCommit(testDir, 'empty');
    expect(hash).toBeUndefined();
  });
});
