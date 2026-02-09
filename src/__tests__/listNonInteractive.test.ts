/**
 * Tests for listNonInteractive — non-interactive list output and branch actions.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listTasks } from '../features/tasks/list/index.js';

describe('listTasks non-interactive text output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-ni-'));
    execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should output pending tasks in text format', async () => {
    // Given
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'my-task.md'), 'Fix the login bug');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When
    await listTasks(tmpDir, undefined, { enabled: true });

    // Then
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('[running] my-task'));
    expect(calls).not.toContainEqual(expect.stringContaining('[pending] my-task'));
    expect(calls).not.toContainEqual(expect.stringContaining('[pendig] my-task'));
    expect(calls).toContainEqual(expect.stringContaining('Fix the login bug'));
    logSpy.mockRestore();
  });

  it('should output failed tasks in text format', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_failed-task');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'failed-task.md'), 'This failed');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When
    await listTasks(tmpDir, undefined, { enabled: true });

    // Then
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('[failed] failed-task'));
    expect(calls).toContainEqual(expect.stringContaining('This failed'));
    logSpy.mockRestore();
  });

  it('should output both pending and failed tasks in text format', async () => {
    // Given
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'pending-one.md'), 'Pending task');

    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_failed-one');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'failed-one.md'), 'Failed task');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When
    await listTasks(tmpDir, undefined, { enabled: true });

    // Then
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls).toContainEqual(expect.stringContaining('[running] pending-one'));
    expect(calls).not.toContainEqual(expect.stringContaining('[pending] pending-one'));
    expect(calls).not.toContainEqual(expect.stringContaining('[pendig] pending-one'));
    expect(calls).toContainEqual(expect.stringContaining('[failed] failed-one'));
    logSpy.mockRestore();
  });

  it('should show info message when no tasks exist', async () => {
    // Given: no tasks, no branches

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When
    await listTasks(tmpDir, undefined, { enabled: true });

    // Then
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('No tasks to list'))).toBe(true);
    logSpy.mockRestore();
  });
});

describe('listTasks non-interactive action errors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-ni-err-'));
    execFileSync('git', ['init', '--initial-branch', 'main'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
    // Create a pending task so the "no tasks" early return is not triggered
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'dummy.md'), 'dummy');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should exit with code 1 when --action specified without --branch', async () => {
    // Given
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When / Then
    await expect(
      listTasks(tmpDir, undefined, { enabled: true, action: 'diff' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should exit with code 1 for invalid action', async () => {
    // Given
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When / Then
    await expect(
      listTasks(tmpDir, undefined, { enabled: true, action: 'invalid', branch: 'some-branch' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should exit with code 1 when branch not found', async () => {
    // Given
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When / Then
    await expect(
      listTasks(tmpDir, undefined, { enabled: true, action: 'diff', branch: 'takt/nonexistent' }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should exit with code 1 for delete without --yes', async () => {
    // Given: create a branch so it's found
    execFileSync('git', ['checkout', '-b', 'takt/20250115-test-branch'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', 'main'], { cwd: tmpDir, stdio: 'pipe' });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When / Then
    await expect(
      listTasks(tmpDir, undefined, {
        enabled: true,
        action: 'delete',
        branch: 'takt/20250115-test-branch',
      }),
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});
