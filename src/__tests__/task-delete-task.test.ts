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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const testDir = `/tmp/takt-delete-task-test-${Date.now()}`;
  let runner: TaskRunner;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
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
      start_movement: 'implement',
      exceeded_max_movements: 60,
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
