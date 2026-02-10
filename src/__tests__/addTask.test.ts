import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'claude' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
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

vi.mock('../infra/config/loaders/pieceResolver.js', () => ({
  getPieceDescription: vi.fn(() => ({
    name: 'default',
    description: '',
    pieceStructure: '1. implement\n2. review',
    movementPreviews: [],
  })),
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
import { determinePiece } from '../features/tasks/execute/selectAndExecute.js';
import { resolveIssueTask, createIssue } from '../infra/github/issue.js';
import { addTask } from '../features/tasks/index.js';

const mockResolveIssueTask = vi.mocked(resolveIssueTask);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockCreateIssue = vi.mocked(createIssue);

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

  it('should create task entry from interactive result', async () => {
    mockInteractiveMode.mockResolvedValue({ action: 'execute', task: '# 認証機能追加\nJWT認証を実装する' });

    await addTask(testDir);

    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.content).toBeUndefined();
    expect(tasks[0]?.task_dir).toBeTypeOf('string');
    expect(readOrderContent(testDir, tasks[0]?.task_dir)).toContain('JWT認証を実装する');
    expect(tasks[0]?.piece).toBe('default');
  });

  it('should include worktree settings when enabled', async () => {
    mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'Task content' });
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValueOnce('/custom/path').mockResolvedValueOnce('feat/branch');

    await addTask(testDir);

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe('/custom/path');
    expect(task.branch).toBe('feat/branch');
  });

  it('should create task from issue reference without interactive mode', async () => {
    mockResolveIssueTask.mockReturnValue('Issue #99: Fix login timeout');
    mockConfirm.mockResolvedValue(false);

    await addTask(testDir, '#99');

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(readOrderContent(testDir, task.task_dir)).toContain('Fix login timeout');
    expect(task.issue).toBe(99);
  });

  it('should not create task when piece selection is cancelled', async () => {
    mockDeterminePiece.mockResolvedValue(null);

    await addTask(testDir);

    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should create issue and save task when create_issue action is chosen', async () => {
    // Given
    mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature' });
    mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/55' });
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir);

    // Then
    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.issue).toBe(55);
    expect(tasks[0]?.content).toBeUndefined();
    expect(readOrderContent(testDir, tasks[0]?.task_dir)).toContain('New feature');
  });

  it('should not save task when issue creation fails in create_issue action', async () => {
    // Given
    mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature' });
    mockCreateIssue.mockReturnValue({ success: false, error: 'auth failed' });

    // When
    await addTask(testDir);

    // Then
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });
});
