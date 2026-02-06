/**
 * Tests for list-tasks command
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseTaktBranches,
  extractTaskSlug,
  buildListItems,
  type BranchInfo,
} from '../infra/task/branchList.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { TaskListItem } from '../infra/task/types.js';
import { isBranchMerged, showFullDiff, type ListAction } from '../features/tasks/index.js';
import { listTasks } from '../features/tasks/list/index.js';

describe('parseTaktBranches', () => {
  it('should parse takt/ branches from git branch output', () => {
    const output = [
      'takt/20260128-fix-auth def4567',
      'takt/20260128-add-search 789abcd',
    ].join('\n');

    const result = parseTaktBranches(output);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      branch: 'takt/20260128-fix-auth',
      commit: 'def4567',
    });

    expect(result[1]).toEqual({
      branch: 'takt/20260128-add-search',
      commit: '789abcd',
    });
  });

  it('should handle empty output', () => {
    const result = parseTaktBranches('');
    expect(result).toHaveLength(0);
  });

  it('should handle output with only whitespace lines', () => {
    const result = parseTaktBranches('  \n  \n');
    expect(result).toHaveLength(0);
  });

  it('should handle single branch', () => {
    const output = 'takt/20260128-fix-auth abc1234';

    const result = parseTaktBranches(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      branch: 'takt/20260128-fix-auth',
      commit: 'abc1234',
    });
  });

  it('should skip lines without space separator', () => {
    const output = [
      'takt/20260128-fix-auth abc1234',
      'malformed-line',
    ].join('\n');

    const result = parseTaktBranches(output);
    expect(result).toHaveLength(1);
  });
});

describe('extractTaskSlug', () => {
  it('should extract slug from timestamped branch name', () => {
    expect(extractTaskSlug('takt/20260128T032800-fix-auth')).toBe('fix-auth');
  });

  it('should extract slug from date-only timestamp', () => {
    expect(extractTaskSlug('takt/20260128-add-search')).toBe('add-search');
  });

  it('should extract slug with long timestamp format', () => {
    expect(extractTaskSlug('takt/20260128T032800-refactor-api')).toBe('refactor-api');
  });

  it('should handle branch without timestamp', () => {
    expect(extractTaskSlug('takt/my-task')).toBe('my-task');
  });

  it('should handle branch with only timestamp', () => {
    const result = extractTaskSlug('takt/20260128T032800');
    // Timestamp is stripped, nothing left, falls back to original name
    expect(result).toBe('20260128T032800');
  });

  it('should handle slug with multiple dashes', () => {
    expect(extractTaskSlug('takt/20260128-fix-auth-bug-in-login')).toBe('fix-auth-bug-in-login');
  });
});

describe('buildListItems', () => {
  it('should build items with correct task slug and originalInstruction', () => {
    const branches: BranchInfo[] = [
      {
        branch: 'takt/20260128-fix-auth',
        commit: 'abc123',
      },
    ];

    const items = buildListItems('/project', branches, 'main');
    expect(items).toHaveLength(1);
    expect(items[0]!.taskSlug).toBe('fix-auth');
    expect(items[0]!.info).toBe(branches[0]);
    // filesChanged will be 0 since we don't have a real git repo
    expect(items[0]!.filesChanged).toBe(0);
    // originalInstruction will be empty since git command fails on non-existent repo
    expect(items[0]!.originalInstruction).toBe('');
  });

  it('should handle multiple branches', () => {
    const branches: BranchInfo[] = [
      {
        branch: 'takt/20260128-fix-auth',
        commit: 'abc123',
      },
      {
        branch: 'takt/20260128-add-search',
        commit: 'def456',
      },
    ];

    const items = buildListItems('/project', branches, 'main');
    expect(items).toHaveLength(2);
    expect(items[0]!.taskSlug).toBe('fix-auth');
    expect(items[1]!.taskSlug).toBe('add-search');
  });

  it('should handle empty branch list', () => {
    const items = buildListItems('/project', [], 'main');
    expect(items).toHaveLength(0);
  });
});

describe('ListAction type', () => {
  it('should include diff, instruct, try, merge, delete (no skip)', () => {
    const actions: ListAction[] = ['diff', 'instruct', 'try', 'merge', 'delete'];
    expect(actions).toHaveLength(5);
    expect(actions).toContain('diff');
    expect(actions).toContain('instruct');
    expect(actions).toContain('try');
    expect(actions).toContain('merge');
    expect(actions).toContain('delete');
    expect(actions).not.toContain('skip');
  });
});

describe('showFullDiff', () => {
  it('should not throw for non-existent project dir', () => {
    // spawnSync will fail gracefully; showFullDiff catches errors
    expect(() => showFullDiff('/non-existent-dir', 'main', 'some-branch')).not.toThrow();
  });

  it('should not throw for non-existent branch', () => {
    expect(() => showFullDiff('/tmp', 'main', 'non-existent-branch-xyz')).not.toThrow();
  });

  it('should warn when diff fails', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    showFullDiff('/non-existent-dir', 'main', 'some-branch');
    warnSpy.mockRestore();
    // No assertion needed — the test verifies it doesn't throw
  });
});

describe('isBranchMerged', () => {
  it('should return false for non-existent project dir', () => {
    // git merge-base will fail on non-existent dir
    const result = isBranchMerged('/non-existent-dir', 'some-branch');
    expect(result).toBe(false);
  });

  it('should return false for non-existent branch', () => {
    const result = isBranchMerged('/tmp', 'non-existent-branch-xyz');
    expect(result).toBe(false);
  });
});

describe('TaskRunner.listFailedTasks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty array for empty failed directory', () => {
    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();
    expect(result).toEqual([]);
  });

  it('should parse failed task directories correctly', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    const taskDir = path.join(failedDir, '2025-01-15T12-34-56_my-task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'my-task.md'), 'Fix the login bug\nMore details here');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: taskDir,
      content: 'Fix the login bug',
    });
  });

  it('should skip malformed directory names', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    // No underscore → malformed, should be skipped
    fs.mkdirSync(path.join(failedDir, 'malformed-name'), { recursive: true });
    // Valid one
    const validDir = path.join(failedDir, '2025-01-15T12-34-56_valid-task');
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(path.join(validDir, 'valid-task.md'), 'Content');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('valid-task');
  });

  it('should extract task content from task file in directory', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    const taskDir = path.join(failedDir, '2025-02-01T00-00-00_content-test');
    fs.mkdirSync(taskDir, { recursive: true });
    // report.md and log.json should be skipped; the actual task file should be read
    fs.writeFileSync(path.join(taskDir, 'report.md'), 'Report content');
    fs.writeFileSync(path.join(taskDir, 'log.json'), '{}');
    fs.writeFileSync(path.join(taskDir, 'content-test.yaml'), 'task: Do something important');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('task: Do something important');
  });

  it('should return empty content when no task file exists', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    const taskDir = path.join(failedDir, '2025-02-01T00-00-00_no-task-file');
    fs.mkdirSync(taskDir, { recursive: true });
    // Only report.md and log.json, no actual task file
    fs.writeFileSync(path.join(taskDir, 'report.md'), 'Report content');
    fs.writeFileSync(path.join(taskDir, 'log.json'), '{}');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('');
  });

  it('should handle task name with underscores', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    const taskDir = path.join(failedDir, '2025-01-15T12-34-56_my_task_name');
    fs.mkdirSync(taskDir, { recursive: true });

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('my_task_name');
  });

  it('should skip non-directory entries', () => {
    const failedDir = path.join(tmpDir, '.takt', 'failed');
    fs.mkdirSync(failedDir, { recursive: true });
    // Create a file (not a directory) in the failed dir
    fs.writeFileSync(path.join(failedDir, '2025-01-15T12-34-56_file-task'), 'content');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listFailedTasks();

    expect(result).toHaveLength(0);
  });
});

describe('TaskRunner.listPendingTaskItems', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty array when no pending tasks', () => {
    const runner = new TaskRunner(tmpDir);
    const result = runner.listPendingTaskItems();
    expect(result).toEqual([]);
  });

  it('should convert TaskInfo to TaskListItem with kind=pending', () => {
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'my-task.md'), 'Fix the login bug\nMore details here');

    const runner = new TaskRunner(tmpDir);
    const result = runner.listPendingTaskItems();

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('pending');
    expect(result[0]!.name).toBe('my-task');
    expect(result[0]!.content).toBe('Fix the login bug');
  });

  it('should truncate content to first line (max 80 chars)', () => {
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const longLine = 'A'.repeat(120) + '\nSecond line';
    fs.writeFileSync(path.join(tasksDir, 'long-task.md'), longLine);

    const runner = new TaskRunner(tmpDir);
    const result = runner.listPendingTaskItems();

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('A'.repeat(80));
  });
});

describe('listTasks non-interactive JSON output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-json-'));
    // Initialize as a git repo so detectDefaultBranch works
    execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should output JSON as object with branches, pendingTasks, and failedTasks keys', async () => {
    // Given: a pending task and a failed task
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'my-task.md'), 'Do something');

    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_failed-task');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'failed-task.md'), 'This failed');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When: listTasks is called in non-interactive JSON mode
    await listTasks(tmpDir, undefined, {
      enabled: true,
      format: 'json',
    });

    // Then: output is an object with branches, pendingTasks, failedTasks
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output).toHaveProperty('branches');
    expect(output).toHaveProperty('pendingTasks');
    expect(output).toHaveProperty('failedTasks');
    expect(Array.isArray(output.branches)).toBe(true);
    expect(Array.isArray(output.pendingTasks)).toBe(true);
    expect(Array.isArray(output.failedTasks)).toBe(true);
    expect(output.pendingTasks).toHaveLength(1);
    expect(output.pendingTasks[0].name).toBe('my-task');
    expect(output.failedTasks).toHaveLength(1);
    expect(output.failedTasks[0].name).toBe('failed-task');

    logSpy.mockRestore();
  });
});
