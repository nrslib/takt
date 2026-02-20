import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  promptInput: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  determinePiece: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('test-task'),
}));

vi.mock('../infra/github/issue.js', () => ({
  isIssueReference: vi.fn((s: string) => /^#\d+$/.test(s)),
  resolveIssueTask: vi.fn(),
  parseIssueNumbers: vi.fn((args: string[]) => {
    const numbers: number[] = [];
    for (const arg of args) {
      const match = arg.match(/^#(\d+)$/);
      if (match?.[1]) {
        numbers.push(Number.parseInt(match[1], 10));
      }
    }
    return numbers;
  }),
  createIssue: vi.fn(),
}));

import { interactiveMode } from '../features/interactive/index.js';
import { promptInput, confirm } from '../shared/prompt/index.js';
import { info } from '../shared/ui/index.js';
import { determinePiece } from '../features/tasks/execute/selectAndExecute.js';
import { resolveIssueTask } from '../infra/github/issue.js';
import { addTask } from '../features/tasks/index.js';

const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockInfo = vi.mocked(info);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockResolveIssueTask = vi.mocked(resolveIssueTask);

let testDir: string;

function loadTasks(dir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(dir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-'));
  mockDeterminePiece.mockResolvedValue('default');
  mockConfirm.mockResolvedValue(false);
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('addTask', () => {
  function readOrderContent(dir: string, taskDir: unknown): string {
    return fs.readFileSync(path.join(dir, String(taskDir), 'order.md'), 'utf-8');
  }

  it('should show usage and exit when task is missing', async () => {
    await addTask(testDir);

    expect(mockInfo).toHaveBeenCalledWith('Usage: takt add <task>');
    expect(mockDeterminePiece).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should show usage and exit when task is blank', async () => {
    await addTask(testDir, '   ');

    expect(mockInfo).toHaveBeenCalledWith('Usage: takt add <task>');
    expect(mockDeterminePiece).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should save plain text task without interactive mode', async () => {
    await addTask(testDir, '  JWT認証を実装する  ');

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.task_dir).toBeTypeOf('string');
    expect(readOrderContent(testDir, task.task_dir)).toContain('JWT認証を実装する');
    expect(task.piece).toBe('default');
    expect(task.worktree).toBe(true);
  });

  it('should include worktree settings when enabled', async () => {
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValueOnce('/custom/path').mockResolvedValueOnce('feat/branch');

    await addTask(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe('/custom/path');
    expect(task.branch).toBe('feat/branch');
    expect(task.auto_pr).toBe(true);
  });

  it('should create task from issue reference without interactive mode', async () => {
    mockResolveIssueTask.mockReturnValue('Issue #99: Fix login timeout');

    await addTask(testDir, '#99');

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(readOrderContent(testDir, task.task_dir)).toContain('Fix login timeout');
    expect(task.issue).toBe(99);
  });

  it('should not create task when piece selection is cancelled', async () => {
    mockDeterminePiece.mockResolvedValue(null);

    await addTask(testDir, 'Task content');

    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });
});
