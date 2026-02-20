/**
 * Tests for task execution resolution.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskInfo } from '../infra/task/index.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-resolve-task-test-'));
  tempRoots.add(root);
  return root;
}

function createTask(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    filePath: '/tasks/task.yaml',
    name: 'task-name',
    content: 'Run task',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    data: { task: 'Run task' },
    ...overrides,
  };
}

describe('resolveTaskExecution', () => {
  it('should return defaults when task data is null', async () => {
    const root = createTempProjectDir();
    const task = createTask({ data: null });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(result).toEqual({
      execCwd: root,
      execPiece: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
    });
  });

  it('should generate report context and copy issue-bearing task spec', async () => {
    const root = createTempProjectDir();
    const taskDir = '.takt/tasks/issue-task-123';
    const sourceTaskDir = path.join(root, taskDir);
    const sourceOrderPath = path.join(sourceTaskDir, 'order.md');
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(sourceOrderPath, '# task instruction');

    const task = createTask({
      taskDir,
      data: {
        task: 'Run issue task',
        issue: 12345,
        auto_pr: true,
      },
    });

    const result = await resolveTaskExecution(task, root, 'default');
    const expectedReportOrderPath = path.join(root, '.takt', 'runs', 'issue-task-123', 'context', 'task', 'order.md');

    expect(result).toMatchObject({
      execCwd: root,
      execPiece: 'default',
      isWorktree: false,
      autoPr: true,
      draftPr: false,
      reportDirName: 'issue-task-123',
      issueNumber: 12345,
      taskPrompt: expect.stringContaining('Primary spec: `.takt/runs/issue-task-123/context/task/order.md`'),
    });
    expect(fs.existsSync(expectedReportOrderPath)).toBe(true);
    expect(fs.readFileSync(expectedReportOrderPath, 'utf-8')).toBe('# task instruction');
  });

  it('draft_pr: true が draftPr: true として解決される', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run draft task',
        auto_pr: true,
        draft_pr: true,
      },
    });

    const result = await resolveTaskExecution(task, root, 'default');

    expect(result.draftPr).toBe(true);
    expect(result.autoPr).toBe(true);
  });
});
