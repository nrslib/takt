/**
 * Tests for taskDeleteActions — pending/failed task deletion
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-delete-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deletePendingTask', () => {
  it('should delete pending task file when confirmed', async () => {
    // Given
    const filePath = path.join(tmpDir, 'my-task.md');
    fs.writeFileSync(filePath, 'task content');
    const task: TaskListItem = {
      kind: 'pending',
      name: 'my-task',
      createdAt: '2025-01-15',
      filePath,
      content: 'task content',
    };
    mockConfirm.mockResolvedValue(true);

    // When
    const result = await deletePendingTask(task);

    // Then
    expect(result).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mockSuccess).toHaveBeenCalledWith('Deleted pending task: my-task');
  });

  it('should not delete when user declines confirmation', async () => {
    // Given
    const filePath = path.join(tmpDir, 'my-task.md');
    fs.writeFileSync(filePath, 'task content');
    const task: TaskListItem = {
      kind: 'pending',
      name: 'my-task',
      createdAt: '2025-01-15',
      filePath,
      content: 'task content',
    };
    mockConfirm.mockResolvedValue(false);

    // When
    const result = await deletePendingTask(task);

    // Then
    expect(result).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should return false and show error when file does not exist', async () => {
    // Given
    const filePath = path.join(tmpDir, 'non-existent.md');
    const task: TaskListItem = {
      kind: 'pending',
      name: 'non-existent',
      createdAt: '2025-01-15',
      filePath,
      content: '',
    };
    mockConfirm.mockResolvedValue(true);

    // When
    const result = await deletePendingTask(task);

    // Then
    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});

describe('deleteFailedTask', () => {
  it('should delete failed task directory when confirmed', async () => {
    // Given
    const dirPath = path.join(tmpDir, '2025-01-15T12-34-56_my-task');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'my-task.md'), 'content');
    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: dirPath,
      content: 'content',
    };
    mockConfirm.mockResolvedValue(true);

    // When
    const result = await deleteFailedTask(task);

    // Then
    expect(result).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(mockSuccess).toHaveBeenCalledWith('Deleted failed task: my-task');
  });

  it('should not delete when user declines confirmation', async () => {
    // Given
    const dirPath = path.join(tmpDir, '2025-01-15T12-34-56_my-task');
    fs.mkdirSync(dirPath, { recursive: true });
    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: dirPath,
      content: '',
    };
    mockConfirm.mockResolvedValue(false);

    // When
    const result = await deleteFailedTask(task);

    // Then
    expect(result).toBe(false);
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should return false and show error when directory does not exist', async () => {
    // Given
    const dirPath = path.join(tmpDir, 'non-existent-dir');
    const task: TaskListItem = {
      kind: 'failed',
      name: 'non-existent',
      createdAt: '2025-01-15T12:34:56',
      filePath: dirPath,
      content: '',
    };
    mockConfirm.mockResolvedValue(true);

    // When
    const result = await deleteFailedTask(task);

    // Then
    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});
