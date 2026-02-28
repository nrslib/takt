import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const mockCheckCliStatus = vi.fn();
const mockFetchPrReviewComments = vi.fn();

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

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    createIssue: vi.fn(),
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
  }),
}));

const mockIsIssueReference = vi.fn((s: string) => /^#\d+$/.test(s));
const mockResolveIssueTask = vi.fn();
const mockParseIssueNumbers = vi.fn((args: string[]) => {
  const numbers: number[] = [];
  for (const arg of args) {
    const match = arg.match(/^#(\d+)$/);
    if (match?.[1]) {
      numbers.push(Number.parseInt(match[1], 10));
    }
  }
  return numbers;
});
const mockFormatPrReviewAsTask = vi.fn();

vi.mock('../infra/github/index.js', () => ({
  isIssueReference: (...args: unknown[]) => mockIsIssueReference(...args),
  resolveIssueTask: (...args: unknown[]) => mockResolveIssueTask(...args),
  parseIssueNumbers: (...args: unknown[]) => mockParseIssueNumbers(...args),
  formatPrReviewAsTask: (...args: unknown[]) => mockFormatPrReviewAsTask(...args),
}));

import { interactiveMode } from '../features/interactive/index.js';
import { promptInput, confirm } from '../shared/prompt/index.js';
import { error, info } from '../shared/ui/index.js';
import { determinePiece } from '../features/tasks/execute/selectAndExecute.js';
import { addTask } from '../features/tasks/index.js';
import type { PrReviewData } from '../infra/git/index.js';

const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockInfo = vi.mocked(info);
const mockError = vi.mocked(error);
const mockDeterminePiece = vi.mocked(determinePiece);

let testDir: string;

function loadTasks(dir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(dir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function addTaskWithPrOption(cwd: string, task: string, prNumber: number): Promise<void> {
  return addTask(cwd, task, { prNumber });
}

function createMockPrReview(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    number: 456,
    title: 'Fix auth bug',
    body: 'PR description',
    url: 'https://github.com/org/repo/pull/456',
    headRefName: 'feature/fix-auth-bug',
    comments: [{ author: 'commenter', body: 'Please update tests' }],
    reviews: [{ author: 'reviewer', body: 'Fix null check' }],
    files: ['src/auth.ts'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-'));
  mockDeterminePiece.mockResolvedValue('default');
  mockConfirm.mockResolvedValue(false);
  mockCheckCliStatus.mockReturnValue({ available: true });
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
    expect(mockIsIssueReference).toHaveBeenCalledWith('#99');
    expect(mockParseIssueNumbers).toHaveBeenCalledWith(['#99']);
    expect(mockResolveIssueTask).toHaveBeenCalledWith('#99');
    expect(mockCheckCliStatus).not.toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(readOrderContent(testDir, task.task_dir)).toContain('Fix login timeout');
    expect(task.issue).toBe(99);
  });

  it('should create task from PR review comments with PR-specific task settings', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockCheckCliStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockFetchPrReviewComments.mock.invocationCallOrder[0],
    );
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
    expect(mockFormatPrReviewAsTask).toHaveBeenCalledWith(prReview);
    expect(mockIsIssueReference).not.toHaveBeenCalled();
    expect(mockParseIssueNumbers).not.toHaveBeenCalled();
    expect(mockResolveIssueTask).not.toHaveBeenCalled();
    expect(mockPromptInput).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDeterminePiece).toHaveBeenCalledTimes(1);
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.branch).toBe('feature/fix-auth-bug');
    expect(task.auto_pr).toBe(false);
    expect(task.worktree).toBe(true);
    expect(task.draft_pr).toBeUndefined();
    expect(readOrderContent(testDir, task.task_dir)).toContain(formattedTask);
  });

  it('should not create a PR task when PR has no review comments', async () => {
    const prReview = createMockPrReview({ comments: [], reviews: [] });
    mockFetchPrReviewComments.mockReturnValue(prReview);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDeterminePiece).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should show error and not create task when fetchPrReviewComments throws', async () => {
    mockFetchPrReviewComments.mockImplementation(() => { throw new Error('network timeout'); });

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDeterminePiece).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('network timeout'));
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not create a PR task when CLI is unavailable', async () => {
    mockCheckCliStatus.mockReturnValue({ available: false, error: 'gh CLI is not available' });

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockFetchPrReviewComments).not.toHaveBeenCalled();
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDeterminePiece).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not perform issue parsing when PR task text looks like issue reference', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, '#99', 456);

    expect(mockIsIssueReference).not.toHaveBeenCalled();

    expect(mockParseIssueNumbers).not.toHaveBeenCalled();
    expect(mockResolveIssueTask).not.toHaveBeenCalled();
    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
    expect(mockFormatPrReviewAsTask).toHaveBeenCalledWith(prReview);
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.branch).toBe('feature/fix-auth-bug');
    expect(task.auto_pr).toBe(false);
  });

  it('should not create task when piece selection is cancelled', async () => {
    mockDeterminePiece.mockResolvedValue(null);

    await addTask(testDir, 'Task content');

    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not save PR task when piece selection is cancelled', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockDeterminePiece.mockResolvedValue(null);
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456);
    expect(mockFormatPrReviewAsTask).toHaveBeenCalledWith(prReview);
    expect(mockDeterminePiece).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });
});
