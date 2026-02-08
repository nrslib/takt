/**
 * Task runner tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../infra/task/runner.js';
import { isTaskFile, parseTaskFiles } from '../infra/task/parser.js';

describe('isTaskFile', () => {
  it('should accept .yaml files', () => {
    expect(isTaskFile('task.yaml')).toBe(true);
  });

  it('should accept .yml files', () => {
    expect(isTaskFile('task.yml')).toBe(true);
  });

  it('should accept .md files', () => {
    expect(isTaskFile('task.md')).toBe(true);
  });

  it('should reject extensionless files like TASK-FORMAT', () => {
    expect(isTaskFile('TASK-FORMAT')).toBe(false);
  });

  it('should reject .txt files', () => {
    expect(isTaskFile('readme.txt')).toBe(false);
  });
});

describe('parseTaskFiles', () => {
  const testDir = `/tmp/takt-parse-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should ignore extensionless files like TASK-FORMAT', () => {
    writeFileSync(join(testDir, 'TASK-FORMAT'), 'Format documentation');
    writeFileSync(join(testDir, 'real-task.md'), 'Real task');

    const tasks = parseTaskFiles(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.name).toBe('real-task');
  });
});

describe('TaskRunner', () => {
  const testDir = `/tmp/takt-task-test-${Date.now()}`;
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

  describe('ensureDirs', () => {
    it('should create tasks, completed, and failed directories', () => {
      runner.ensureDirs();
      expect(existsSync(join(testDir, '.takt', 'tasks'))).toBe(true);
      expect(existsSync(join(testDir, '.takt', 'completed'))).toBe(true);
      expect(existsSync(join(testDir, '.takt', 'failed'))).toBe(true);
    });
  });

  describe('listTasks', () => {
    it('should return empty array when no tasks', () => {
      const tasks = runner.listTasks();
      expect(tasks).toEqual([]);
    });

    it('should list tasks sorted by name', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, '02-second.md'), 'Second task');
      writeFileSync(join(tasksDir, '01-first.md'), 'First task');
      writeFileSync(join(tasksDir, '03-third.md'), 'Third task');

      const tasks = runner.listTasks();
      expect(tasks).toHaveLength(3);
      expect(tasks[0]?.name).toBe('01-first');
      expect(tasks[1]?.name).toBe('02-second');
      expect(tasks[2]?.name).toBe('03-third');
    });

    it('should only list .md files', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'task.md'), 'Task content');
      writeFileSync(join(tasksDir, 'readme.txt'), 'Not a task');

      const tasks = runner.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.name).toBe('task');
    });
  });

  describe('getTask', () => {
    it('should return null for non-existent task', () => {
      const task = runner.getTask('non-existent');
      expect(task).toBeNull();
    });

    it('should return task info for existing task', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'my-task.md'), 'Task content');

      const task = runner.getTask('my-task');
      expect(task).not.toBeNull();
      expect(task?.name).toBe('my-task');
      expect(task?.content).toBe('Task content');
    });
  });

  describe('getNextTask', () => {
    it('should return null when no tasks', () => {
      const task = runner.getNextTask();
      expect(task).toBeNull();
    });

    it('should return first task (alphabetically)', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'b-task.md'), 'B');
      writeFileSync(join(tasksDir, 'a-task.md'), 'A');

      const task = runner.getNextTask();
      expect(task?.name).toBe('a-task');
    });
  });

  describe('claimNextTasks', () => {
    it('should return empty array when no tasks', () => {
      const tasks = runner.claimNextTasks(3);
      expect(tasks).toEqual([]);
    });

    it('should return tasks up to the requested count', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'a-task.md'), 'A');
      writeFileSync(join(tasksDir, 'b-task.md'), 'B');
      writeFileSync(join(tasksDir, 'c-task.md'), 'C');

      const tasks = runner.claimNextTasks(2);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]?.name).toBe('a-task');
      expect(tasks[1]?.name).toBe('b-task');
    });

    it('should not return already claimed tasks on subsequent calls', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'a-task.md'), 'A');
      writeFileSync(join(tasksDir, 'b-task.md'), 'B');
      writeFileSync(join(tasksDir, 'c-task.md'), 'C');

      // Given: first call claims a-task
      const first = runner.claimNextTasks(1);
      expect(first).toHaveLength(1);
      expect(first[0]?.name).toBe('a-task');

      // When: second call should skip a-task
      const second = runner.claimNextTasks(1);
      expect(second).toHaveLength(1);
      expect(second[0]?.name).toBe('b-task');

      // When: third call should skip a-task and b-task
      const third = runner.claimNextTasks(1);
      expect(third).toHaveLength(1);
      expect(third[0]?.name).toBe('c-task');

      // When: fourth call should return empty (all claimed)
      const fourth = runner.claimNextTasks(1);
      expect(fourth).toEqual([]);
    });

    it('should release claim after completeTask', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'task-a.md'), 'Task A content');

      // Given: claim the task
      const claimed = runner.claimNextTasks(1);
      expect(claimed).toHaveLength(1);

      // When: complete the task (file is moved away)
      runner.completeTask({
        task: claimed[0]!,
        success: true,
        response: 'Done',
        executionLog: [],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      });

      // Then: claim set no longer blocks (but file is moved, so no tasks anyway)
      const next = runner.claimNextTasks(1);
      expect(next).toEqual([]);
    });

    it('should release claim after failTask', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'task-a.md'), 'Task A content');

      // Given: claim the task
      const claimed = runner.claimNextTasks(1);
      expect(claimed).toHaveLength(1);

      // When: fail the task (file is moved away)
      runner.failTask({
        task: claimed[0]!,
        success: false,
        response: 'Error',
        executionLog: [],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      });

      // Then: claim set no longer blocks
      const next = runner.claimNextTasks(1);
      expect(next).toEqual([]);
    });

    it('should not affect getNextTask (unclaimed access)', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'a-task.md'), 'A');
      writeFileSync(join(tasksDir, 'b-task.md'), 'B');

      // Given: claim a-task via claimNextTasks
      runner.claimNextTasks(1);

      // When: getNextTask is called (no claim filtering)
      const task = runner.getNextTask();

      // Then: getNextTask still returns first task (including claimed)
      expect(task?.name).toBe('a-task');
    });
  });

  describe('completeTask', () => {
    it('should move task to completed directory', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      const taskFile = join(tasksDir, 'test-task.md');
      writeFileSync(taskFile, 'Test task content');

      const task = runner.getTask('test-task')!;
      const result = {
        task,
        success: true,
        response: 'Task completed successfully',
        executionLog: ['Started', 'Done'],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      };

      const reportFile = runner.completeTask(result);

      // Original task file should be moved
      expect(existsSync(taskFile)).toBe(false);

      // Report should be created
      expect(existsSync(reportFile)).toBe(true);
      const reportContent = readFileSync(reportFile, 'utf-8');
      expect(reportContent).toContain('# タスク実行レポート');
      expect(reportContent).toContain('test-task');
      expect(reportContent).toContain('成功');

      // Log file should be created
      const logFile = reportFile.replace('report.md', 'log.json');
      expect(existsSync(logFile)).toBe(true);
      const logData = JSON.parse(readFileSync(logFile, 'utf-8'));
      expect(logData.taskName).toBe('test-task');
      expect(logData.success).toBe(true);
    });

    it('should throw error when called with a failed result', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, 'fail-task.md'), 'Will fail');

      const task = runner.getTask('fail-task')!;
      const result = {
        task,
        success: false,
        response: 'Error occurred',
        executionLog: ['Error'],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      };

      expect(() => runner.completeTask(result)).toThrow(
        'Cannot complete a failed task. Use failTask() instead.'
      );
    });
  });

  describe('failTask', () => {
    it('should move task to failed directory', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      const taskFile = join(tasksDir, 'fail-task.md');
      writeFileSync(taskFile, 'Task that will fail');

      const task = runner.getTask('fail-task')!;
      const result = {
        task,
        success: false,
        response: 'Error occurred',
        executionLog: ['Started', 'Error'],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      };

      const reportFile = runner.failTask(result);

      // Original task file should be removed from tasks dir
      expect(existsSync(taskFile)).toBe(false);

      // Report should be in .takt/failed/ (not .takt/completed/)
      expect(reportFile).toContain(join('.takt', 'failed'));
      expect(reportFile).not.toContain(join('.takt', 'completed'));
      expect(existsSync(reportFile)).toBe(true);

      const reportContent = readFileSync(reportFile, 'utf-8');
      expect(reportContent).toContain('# タスク実行レポート');
      expect(reportContent).toContain('fail-task');
      expect(reportContent).toContain('失敗');

      // Log file should be created in failed dir
      const logFile = reportFile.replace('report.md', 'log.json');
      expect(existsSync(logFile)).toBe(true);
      const logData = JSON.parse(readFileSync(logFile, 'utf-8'));
      expect(logData.taskName).toBe('fail-task');
      expect(logData.success).toBe(false);
    });

    it('should not move failed task to completed directory', () => {
      const tasksDir = join(testDir, '.takt', 'tasks');
      const completedDir = join(testDir, '.takt', 'completed');
      mkdirSync(tasksDir, { recursive: true });
      const taskFile = join(tasksDir, 'another-fail.md');
      writeFileSync(taskFile, 'Another failing task');

      const task = runner.getTask('another-fail')!;
      const result = {
        task,
        success: false,
        response: 'Something went wrong',
        executionLog: [],
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
      };

      runner.failTask(result);

      // completed directory should be empty (only the dir itself exists)
      mkdirSync(completedDir, { recursive: true });
      const completedContents = readdirSync(completedDir);
      expect(completedContents).toHaveLength(0);
    });
  });

  describe('getTasksDir', () => {
    it('should return tasks directory path', () => {
      expect(runner.getTasksDir()).toBe(join(testDir, '.takt', 'tasks'));
    });
  });

  describe('requeueFailedTask', () => {
    it('should copy task file from failed to tasks directory', () => {
      runner.ensureDirs();

      // Create a failed task directory
      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_my-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'my-task.yaml'), 'task: Do something\n');
      writeFileSync(join(failedDir, 'report.md'), '# Report');
      writeFileSync(join(failedDir, 'log.json'), '{}');

      const result = runner.requeueFailedTask(failedDir);

      // Task file should be copied to tasks dir
      expect(existsSync(result)).toBe(true);
      expect(result).toBe(join(testDir, '.takt', 'tasks', 'my-task.yaml'));

      // Original failed directory should still exist
      expect(existsSync(failedDir)).toBe(true);

      // Task content should be preserved
      const content = readFileSync(result, 'utf-8');
      expect(content).toBe('task: Do something\n');
    });

    it('should add start_movement to YAML task file when specified', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_retry-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'retry-task.yaml'), 'task: Retry me\npiece: default\n');

      const result = runner.requeueFailedTask(failedDir, 'implement');

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('start_movement: implement');
      expect(content).toContain('task: Retry me');
      expect(content).toContain('piece: default');
    });

    it('should replace existing start_movement in YAML task file', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_replace-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'replace-task.yaml'), 'task: Replace me\nstart_movement: plan\n');

      const result = runner.requeueFailedTask(failedDir, 'ai_review');

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('start_movement: ai_review');
      expect(content).not.toContain('start_movement: plan');
    });

    it('should not modify markdown task files even with startMovement', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_md-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'md-task.md'), '# Task\nDo something');

      const result = runner.requeueFailedTask(failedDir, 'implement');

      const content = readFileSync(result, 'utf-8');
      // Markdown files should not have start_movement added
      expect(content).toBe('# Task\nDo something');
      expect(content).not.toContain('start_movement');
    });

    it('should throw error when no task file found', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_no-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'report.md'), '# Report');

      expect(() => runner.requeueFailedTask(failedDir)).toThrow(
        /No task file found in failed directory/
      );
    });

    it('should throw error when failed directory does not exist', () => {
      runner.ensureDirs();

      expect(() => runner.requeueFailedTask('/nonexistent/path')).toThrow(
        /Failed to read failed task directory/
      );
    });

    it('should add retry_note to YAML task file when specified', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_note-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'note-task.yaml'), 'task: Task with note\n');

      const result = runner.requeueFailedTask(failedDir, undefined, 'Fixed the ENOENT error');

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('retry_note: "Fixed the ENOENT error"');
      expect(content).toContain('task: Task with note');
    });

    it('should escape double quotes in retry_note', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_quote-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'quote-task.yaml'), 'task: Task with quotes\n');

      const result = runner.requeueFailedTask(failedDir, undefined, 'Fixed "spawn node ENOENT" error');

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('retry_note: "Fixed \\"spawn node ENOENT\\" error"');
    });

    it('should add both start_movement and retry_note when both specified', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_both-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'both-task.yaml'), 'task: Task with both\n');

      const result = runner.requeueFailedTask(failedDir, 'implement', 'Retrying from implement');

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('start_movement: implement');
      expect(content).toContain('retry_note: "Retrying from implement"');
    });

    it('should not add retry_note to markdown task files', () => {
      runner.ensureDirs();

      const failedDir = join(testDir, '.takt', 'failed', '2026-01-31T12-00-00_md-note-task');
      mkdirSync(failedDir, { recursive: true });
      writeFileSync(join(failedDir, 'md-note-task.md'), '# Task\nDo something');

      const result = runner.requeueFailedTask(failedDir, undefined, 'Should be ignored');

      const content = readFileSync(result, 'utf-8');
      expect(content).toBe('# Task\nDo something');
      expect(content).not.toContain('retry_note');
    });
  });
});
