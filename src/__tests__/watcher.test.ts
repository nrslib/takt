import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { TaskWatcher } from '../infra/task/watcher.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { TaskInfo } from '../infra/task/types.js';

describe('TaskWatcher', () => {
  const testDir = `/tmp/takt-watcher-test-${Date.now()}`;
  let watcher: TaskWatcher | null = null;

  function writeTasksYaml(tasks: Array<Record<string, unknown>>): void {
    const tasksFile = join(testDir, '.takt', 'tasks.yaml');
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(tasksFile, stringifyYaml({ tasks }), 'utf-8');
  }

  beforeEach(() => {
    mkdirSync(join(testDir, '.takt'), { recursive: true });
  });

  afterEach(() => {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should create watcher with default options', () => {
      watcher = new TaskWatcher(testDir);
      expect(watcher.isRunning()).toBe(false);
    });

    it('should accept custom poll interval', () => {
      watcher = new TaskWatcher(testDir, { pollInterval: 500 });
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('watch', () => {
    it('should detect and process a pending task from tasks.yaml', async () => {
      writeTasksYaml([
        {
          name: 'test-task',
          status: 'pending',
          content: 'Test task content',
          created_at: '2026-02-09T00:00:00.000Z',
          started_at: null,
          completed_at: null,
        },
      ]);

      watcher = new TaskWatcher(testDir, { pollInterval: 50 });
      const processed: string[] = [];

      const watchPromise = watcher.watch(async (task: TaskInfo) => {
        processed.push(task.name);
        watcher?.stop();
      });

      await watchPromise;

      expect(processed).toEqual(['test-task']);
      expect(watcher.isRunning()).toBe(false);
    });

    it('should wait when no tasks are available and then process added task', async () => {
      writeTasksYaml([]);
      watcher = new TaskWatcher(testDir, { pollInterval: 50 });
      const runner = new TaskRunner(testDir);
      let processed = 0;

      const watchPromise = watcher.watch(async () => {
        processed++;
        watcher?.stop();
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      runner.addTask('Delayed task');

      await watchPromise;

      expect(processed).toBe(1);
    });

    it('should process multiple tasks sequentially', async () => {
      writeTasksYaml([
        {
          name: 'a-task',
          status: 'pending',
          content: 'First task',
          created_at: '2026-02-09T00:00:00.000Z',
          started_at: null,
          completed_at: null,
        },
        {
          name: 'b-task',
          status: 'pending',
          content: 'Second task',
          created_at: '2026-02-09T00:01:00.000Z',
          started_at: null,
          completed_at: null,
        },
      ]);

      const runner = new TaskRunner(testDir);
      watcher = new TaskWatcher(testDir, { pollInterval: 50 });
      const processed: string[] = [];

      const watchPromise = watcher.watch(async (task: TaskInfo) => {
        processed.push(task.name);
        runner.completeTask({
          task,
          success: true,
          response: 'Done',
          executionLog: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        if (processed.length >= 2) {
          watcher?.stop();
        }
      });

      await watchPromise;

      expect(processed).toEqual(['a-task', 'b-task']);
    });
  });

  describe('stop', () => {
    it('should stop the watcher gracefully', async () => {
      writeTasksYaml([]);
      watcher = new TaskWatcher(testDir, { pollInterval: 50 });

      const watchPromise = watcher.watch(async () => {
      });

      setTimeout(() => watcher?.stop(), 100);

      await watchPromise;

      expect(watcher.isRunning()).toBe(false);
    });

    it('should abort sleep immediately when stopped', async () => {
      writeTasksYaml([]);
      watcher = new TaskWatcher(testDir, { pollInterval: 10000 });

      const start = Date.now();
      const watchPromise = watcher.watch(async () => {});

      setTimeout(() => watcher?.stop(), 50);

      await watchPromise;

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
