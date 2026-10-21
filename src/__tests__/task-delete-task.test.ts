/**
 * Unit tests for TaskRunner.deleteTask (generic delete by kind)
 *
 * Covers:
 * - deleteTask('name', 'pending') → pending task removed
 * - deleteTask('name', 'failed') → failed task removed
 * - deleteTask('name', 'completed') → completed task removed
 * - deleteTask('name', 'exceeded') → exceeded task removed
 * - Error when task does not exist
 * - Error when kind does not match actual task status
 * - Sibling tasks are not affected
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskRunner } from '../infra/task/runner.js';

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function writeRecord(testDir: string, record: Record<string, unknown>): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

describe('TaskRunner - deleteTask', () => {
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-delete-task-test-'));
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should delete a pending task by kind', () => {
    // Given: a pending task
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: deleteTask is called with kind 'pending'
    runner.deleteTask(taskName, 'pending');

    // Then: task is removed from the store
    expect(loadTasksFile(testDir).tasks).toHaveLength(0);
  });

  it('should delete a failed task by kind', () => {
    // Given: a failed task written directly to YAML
    writeRecord(testDir, {
      name: 'task-a',
      status: 'failed',
      content: 'Do work',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      completed_at: '2026-01-01T00:05:00.000Z',
      owner_pid: null,
      failure: { error: 'Something went wrong' },
    });

    // When: deleteTask is called with kind 'failed'
    runner.deleteTask('task-a', 'failed');

    // Then: task is removed from the store
    expect(loadTasksFile(testDir).tasks).toHaveLength(0);
  });

  it('should delete a completed task by kind', () => {
    // Given: a completed task written directly to YAML
    writeRecord(testDir, {
      name: 'task-a',
      status: 'completed',
      content: 'Do work',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      completed_at: '2026-01-01T00:05:00.000Z',
      owner_pid: null,
    });

    // When: deleteTask is called with kind 'completed'
    runner.deleteTask('task-a', 'completed');

    // Then: task is removed from the store
    expect(loadTasksFile(testDir).tasks).toHaveLength(0);
  });

  it('should delete an exceeded task by kind', () => {
    // Given: an exceeded task written directly to YAML
    writeRecord(testDir, {
      name: 'task-a',
      status: 'exceeded',
      content: 'Do work',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      completed_at: '2026-01-01T00:05:00.000Z',
      owner_pid: null,
      start_step: 'implement',
      exceeded_max_steps: 60,
      exceeded_current_iteration: 30,
    });

    // When: deleteTask is called with kind 'exceeded'
    runner.deleteTask('task-a', 'exceeded');

    // Then: task is removed from the store
    expect(loadTasksFile(testDir).tasks).toHaveLength(0);
  });

  it('should throw when task does not exist', () => {
    // Given: no tasks in the store
    // When/Then: deleteTask throws with not-found error
    expect(() => runner.deleteTask('nonexistent', 'pending')).toThrow(/not found/i);
  });

  it('should throw when kind does not match the actual task status', () => {
    // Given: a pending task
    runner.addTask('Task A');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: deleteTask is called with wrong kind ('failed' instead of 'pending')
    // Then: throws because no running task with that name exists under 'failed' status
    expect(() => runner.deleteTask(taskName, 'failed')).toThrow(/not found/i);
    expect(loadTasksFile(testDir).tasks).toMatchObject([{ name: taskName, status: 'pending' }]);
  });

  it('runs cleanup before removing the record', () => {
    const target = runner.addTask('Task A');
    const cleanup = vi.fn(() => {
      expect(loadTasksFile(testDir).tasks).toMatchObject([{ name: target.name, status: 'pending' }]);
    });

    expect(runner.deleteTask(target.name, 'pending', cleanup)).toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(loadTasksFile(testDir).tasks).toEqual([]);
  });

  it('releases the tasks.yaml lock before running cleanup', () => {
    const target = runner.addTask('Task A');
    let siblingName: string | undefined;

    runner.deleteTask(target.name, 'pending', () => {
      siblingName = runner.addTask('Task B').name;
      expect(loadTasksFile(testDir).tasks).toMatchObject([
        { name: target.name, status: 'pending' },
        { name: siblingName, status: 'pending' },
      ]);
    });

    expect(siblingName).toBeDefined();
    expect(loadTasksFile(testDir).tasks).toMatchObject([{ name: siblingName, status: 'pending' }]);
  });

  it('does not run cleanup when the current status differs', () => {
    const target = runner.addTask('Task A');
    runner.claimNextTasks(1);
    const cleanup = vi.fn();

    expect(() => runner.deleteTask(target.name, 'pending', cleanup)).toThrow(/not found/i);

    expect(cleanup).not.toHaveBeenCalled();
    expect(loadTasksFile(testDir).tasks).toMatchObject([{ name: target.name, status: 'running' }]);
  });

  it('keeps the record and releases the lock if cleanup throws', () => {
    const target = runner.addTask('Task A');
    const before = readFileSync(runner.getTasksFilePath(), 'utf8');
    const failure = new Error('cleanup failed');

    expect(() => runner.deleteTask(target.name, 'pending', () => { throw failure; })).toThrow(failure);

    expect(readFileSync(runner.getTasksFilePath(), 'utf8')).toBe(before);
    expect(runner.claimNextTasks(1)).toMatchObject([{ name: target.name, status: 'running' }]);
  });

  it('should not affect sibling tasks when deleting one task', () => {
    // Given: two pending tasks
    runner.addTask('Task A');
    runner.addTask('Task B');
    const taskName = (loadTasksFile(testDir).tasks[0] as Record<string, unknown>).name as string;

    // When: deleteTask is called for the first task
    runner.deleteTask(taskName, 'pending');

    // Then: only the targeted task is removed; sibling remains
    expect(loadTasksFile(testDir).tasks).toHaveLength(1);
  });
});
