import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

import { confirm } from '../shared/prompt/index.js';
import { success, error as logError } from '../shared/ui/index.js';
import { deletePendingTask, deleteFailedTask } from '../features/tasks/list/taskDeleteActions.js';
import type { TaskListItem } from '../infra/task/types.js';

const mockConfirm = vi.mocked(confirm);
const mockSuccess = vi.mocked(success);
const mockLogError = vi.mocked(logError);

let tmpDir: string;

function setupTasksFile(projectDir: string): string {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-task',
        status: 'pending',
        content: 'pending',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'failed-task',
        status: 'failed',
        content: 'failed',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: '2025-01-15T00:01:00.000Z',
        completed_at: '2025-01-15T00:02:00.000Z',
        failure: { error: 'boom' },
      },
    ],
  }), 'utf-8');
  return tasksFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-delete-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('taskDeleteActions', () => {
  it('should delete pending task when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'pending',
      name: 'pending-task',
      createdAt: '2025-01-15',
      filePath: tasksFile,
      content: 'pending',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deletePendingTask(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('pending-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted pending task: pending-task');
  });

  it('should delete failed task when confirmed', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: 'failed',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteFailedTask(task);

    expect(result).toBe(true);
    const raw = fs.readFileSync(tasksFile, 'utf-8');
    expect(raw).not.toContain('failed-task');
    expect(mockSuccess).toHaveBeenCalledWith('Deleted failed task: failed-task');
  });

  it('should return false when target task is missing', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const task: TaskListItem = {
      kind: 'failed',
      name: 'not-found',
      createdAt: '2025-01-15T12:34:56',
      filePath: tasksFile,
      content: '',
    };
    mockConfirm.mockResolvedValue(true);

    const result = await deleteFailedTask(task);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
  });
});
