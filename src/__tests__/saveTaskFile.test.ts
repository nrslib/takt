import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { success, info } from '../shared/ui/index.js';
import { confirm, promptInput } from '../shared/prompt/index.js';
import { saveTaskFile, saveTaskFromInteractive } from '../features/tasks/add/index.js';

const mockSuccess = vi.mocked(success);
const mockInfo = vi.mocked(info);
const mockConfirm = vi.mocked(confirm);
const mockPromptInput = vi.mocked(promptInput);

let testDir: string;

function loadTasks(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-save-'));
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('saveTaskFile', () => {
  it('should append task to tasks.yaml', async () => {
    const created = await saveTaskFile(testDir, 'Implement feature X\nDetails here');

    expect(created.taskName).toContain('implement-feature-x');
    expect(created.tasksFile).toBe(path.join(testDir, '.takt', 'tasks.yaml'));
    expect(fs.existsSync(created.tasksFile)).toBe(true);

    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.content).toContain('Implement feature X');
  });

  it('should include optional fields', async () => {
    await saveTaskFile(testDir, 'Task', {
      piece: 'review',
      issue: 42,
      worktree: true,
      branch: 'feat/my-branch',
      autoPr: false,
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.piece).toBe('review');
    expect(task.issue).toBe(42);
    expect(task.worktree).toBe(true);
    expect(task.branch).toBe('feat/my-branch');
    expect(task.auto_pr).toBe(false);
  });

  it('should generate unique names on duplicates', async () => {
    const first = await saveTaskFile(testDir, 'Same title');
    const second = await saveTaskFile(testDir, 'Same title');

    expect(first.taskName).not.toBe(second.taskName);
  });
});

describe('saveTaskFromInteractive', () => {
  it('should save task with worktree settings when user confirms', async () => {
    mockConfirm.mockResolvedValueOnce(true);
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(true);

    await saveTaskFromInteractive(testDir, 'Task content');

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Task created:'));
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe(true);
    expect(task.auto_pr).toBe(true);
  });

  it('should save task without worktree settings when declined', async () => {
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBeUndefined();
    expect(task.branch).toBeUndefined();
    expect(task.auto_pr).toBeUndefined();
  });

  it('should display piece info when specified', async () => {
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Task content', 'review');

    expect(mockInfo).toHaveBeenCalledWith('  Piece: review');
  });
});
