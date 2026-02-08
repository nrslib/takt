/**
 * Tests for addTask command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock dependencies before importing the module under test
vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'claude' })),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/prompt/index.js', () => ({
  promptInput: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
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
import { summarizeTaskName } from '../infra/task/summarize.js';
import { determinePiece } from '../features/tasks/execute/selectAndExecute.js';
import { getPieceDescription } from '../infra/config/loaders/pieceResolver.js';
import { resolveIssueTask, createIssue } from '../infra/github/issue.js';
import { addTask } from '../features/tasks/index.js';

const mockResolveIssueTask = vi.mocked(resolveIssueTask);
const mockCreateIssue = vi.mocked(createIssue);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockDeterminePiece = vi.mocked(determinePiece);
const mockGetPieceDescription = vi.mocked(getPieceDescription);

function setupFullFlowMocks(overrides?: {
  task?: string;
  slug?: string;
}) {
  const task = overrides?.task ?? '# 認証機能追加\nJWT認証を実装する';
  const slug = overrides?.slug ?? 'add-auth';

  mockDeterminePiece.mockResolvedValue('default');
  mockGetPieceDescription.mockReturnValue({ name: 'default', description: '', pieceStructure: '' });
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task });
  mockSummarizeTaskName.mockResolvedValue(slug);
  mockConfirm.mockResolvedValue(false);
}

let testDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-'));
  mockDeterminePiece.mockResolvedValue('default');
  mockGetPieceDescription.mockReturnValue({ name: 'default', description: '', pieceStructure: '' });
  mockConfirm.mockResolvedValue(false);
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('addTask', () => {
  it('should cancel when interactive mode is not confirmed', async () => {
    // Given: user cancels interactive mode
    mockDeterminePiece.mockResolvedValue('default');
    mockInteractiveMode.mockResolvedValue({ action: 'cancel', task: '' });

    // When
    await addTask(testDir);

    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
    expect(files.length).toBe(0);
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should create task file with AI-summarized content', async () => {
    // Given: full flow setup
    setupFullFlowMocks();

    // When
    await addTask(testDir);

    // Then: task file created with summarized content
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const taskFile = path.join(tasksDir, 'add-auth.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);

    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('# 認証機能追加');
    expect(content).toContain('JWT認証を実装する');
  });

  it('should use first line of task for filename generation', async () => {
    setupFullFlowMocks({
      task: 'First line summary\nSecond line details',
      slug: 'first-line',
    });

    await addTask(testDir);

    expect(mockSummarizeTaskName).toHaveBeenCalledWith('First line summary', { cwd: testDir });
  });

  it('should append counter for duplicate filenames', async () => {
    // Given: first task creates 'my-task.yaml'
    setupFullFlowMocks({ slug: 'my-task' });
    await addTask(testDir);

    // When: create second task with same slug
    setupFullFlowMocks({ slug: 'my-task' });
    await addTask(testDir);

    // Then: second file has counter
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    expect(fs.existsSync(path.join(tasksDir, 'my-task.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, 'my-task-1.yaml'))).toBe(true);
  });

  it('should include worktree option when confirmed', async () => {
    // Given: user confirms worktree
    setupFullFlowMocks({ slug: 'with-worktree' });
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValue('');

    // When
    await addTask(testDir);

    // Then
    const taskFile = path.join(testDir, '.takt', 'tasks', 'with-worktree.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('worktree: true');
  });

  it('should include custom worktree path when provided', async () => {
    // Given: user provides custom worktree path
    setupFullFlowMocks({ slug: 'custom-path' });
    mockConfirm.mockResolvedValue(true);
    mockPromptInput
      .mockResolvedValueOnce('/custom/path')
      .mockResolvedValueOnce('');

    // When
    await addTask(testDir);

    // Then
    const taskFile = path.join(testDir, '.takt', 'tasks', 'custom-path.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('worktree: /custom/path');
  });

  it('should include branch when provided', async () => {
    // Given: user provides custom branch
    setupFullFlowMocks({ slug: 'with-branch' });
    mockConfirm.mockResolvedValue(true);
    mockPromptInput
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('feat/my-branch');

    // When
    await addTask(testDir);

    // Then
    const taskFile = path.join(testDir, '.takt', 'tasks', 'with-branch.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('branch: feat/my-branch');
  });

  it('should include piece selection in task file', async () => {
    // Given: determinePiece returns a non-default piece
    setupFullFlowMocks({ slug: 'with-piece' });
    mockDeterminePiece.mockResolvedValue('review');
    mockGetPieceDescription.mockReturnValue({ name: 'review', description: 'Code review piece', pieceStructure: '' });
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir);

    // Then
    const taskFile = path.join(testDir, '.takt', 'tasks', 'with-piece.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('piece: review');
  });

  it('should cancel when piece selection returns null', async () => {
    // Given: user cancels piece selection
    mockDeterminePiece.mockResolvedValue(null);

    // When
    await addTask(testDir);

    // Then: no task file created (cancelled at piece selection)
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(0);
  });

  it('should always include piece from determinePiece', async () => {
    // Given: determinePiece returns 'default'
    setupFullFlowMocks({ slug: 'default-wf' });
    mockDeterminePiece.mockResolvedValue('default');
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir);

    // Then: piece field is included
    const taskFile = path.join(testDir, '.takt', 'tasks', 'default-wf.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('piece: default');
  });

  it('should fetch issue and use directly as task content when given issue reference', async () => {
    // Given: issue reference "#99"
    const issueText = 'Issue #99: Fix login timeout\n\nThe login page times out after 30 seconds.';
    mockResolveIssueTask.mockReturnValue(issueText);
    mockDeterminePiece.mockResolvedValue('default');

    mockSummarizeTaskName.mockResolvedValue('fix-login-timeout');
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir, '#99');

    // Then: interactiveMode should NOT be called
    expect(mockInteractiveMode).not.toHaveBeenCalled();

    // Then: resolveIssueTask was called
    expect(mockResolveIssueTask).toHaveBeenCalledWith('#99');

    // Then: determinePiece was called for piece selection
    expect(mockDeterminePiece).toHaveBeenCalledWith(testDir);

    // Then: task file created with issue text directly (no AI summarization)
    const taskFile = path.join(testDir, '.takt', 'tasks', 'fix-login-timeout.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('Fix login timeout');
  });

  it('should proceed to worktree settings after issue fetch', async () => {
    // Given: issue with worktree enabled
    mockResolveIssueTask.mockReturnValue('Issue text');
    mockDeterminePiece.mockResolvedValue('default');
    mockSummarizeTaskName.mockResolvedValue('issue-task');
    mockConfirm.mockResolvedValue(true);
    mockPromptInput
      .mockResolvedValueOnce('')  // worktree path (auto)
      .mockResolvedValueOnce(''); // branch name (auto)

    // When
    await addTask(testDir, '#42');

    // Then: worktree settings applied
    const taskFile = path.join(testDir, '.takt', 'tasks', 'issue-task.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('worktree: true');
  });

  it('should handle GitHub API failure gracefully for issue reference', async () => {
    // Given: resolveIssueTask throws
    mockResolveIssueTask.mockImplementation(() => {
      throw new Error('GitHub API rate limit exceeded');
    });

    // When
    await addTask(testDir, '#99');

    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(0);
  });

  it('should include issue number in task file when issue reference is used', async () => {
    // Given: issue reference "#99"
    const issueText = 'Issue #99: Fix login timeout';
    mockResolveIssueTask.mockReturnValue(issueText);
    mockDeterminePiece.mockResolvedValue('default');
    mockSummarizeTaskName.mockResolvedValue('fix-login-timeout');
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir, '#99');

    // Then: task file contains issue field
    const taskFile = path.join(testDir, '.takt', 'tasks', 'fix-login-timeout.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('issue: 99');
  });

  it('should include piece selection in task file when issue reference is used', async () => {
    // Given: issue reference "#99" with non-default piece selection
    const issueText = 'Issue #99: Fix login timeout';
    mockResolveIssueTask.mockReturnValue(issueText);
    mockDeterminePiece.mockResolvedValue('review');
    mockSummarizeTaskName.mockResolvedValue('fix-login-timeout');
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir, '#99');

    // Then: task file contains piece field
    const taskFile = path.join(testDir, '.takt', 'tasks', 'fix-login-timeout.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('piece: review');
  });

  it('should cancel when piece selection returns null for issue reference', async () => {
    // Given: issue fetched successfully but user cancels piece selection
    const issueText = 'Issue #99: Fix login timeout';
    mockResolveIssueTask.mockReturnValue(issueText);
    mockDeterminePiece.mockResolvedValue(null);

    // When
    await addTask(testDir, '#99');

    // Then: no task file created (cancelled at piece selection)
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(0);

    // Then: issue was fetched before cancellation
    expect(mockResolveIssueTask).toHaveBeenCalledWith('#99');
  });

  it('should call auto-PR confirm with default true', async () => {
    // Given: worktree is confirmed so auto-PR prompt is reached
    setupFullFlowMocks({ slug: 'auto-pr-default' });
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValue('');

    // When
    await addTask(testDir);

    // Then: second confirm call (Auto-create PR?) has defaultYes=true
    const autoPrCall = mockConfirm.mock.calls.find(
      (call) => call[0] === 'Auto-create PR?',
    );
    expect(autoPrCall).toBeDefined();
    expect(autoPrCall![1]).toBe(true);
  });

  describe('create_issue action', () => {
    it('should call createIssue when create_issue action is selected', async () => {
      // Given: interactive mode returns create_issue action
      const task = 'Create a new feature\nWith detailed description';
      mockDeterminePiece.mockResolvedValue('default');
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task });
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      await addTask(testDir);

      // Then: createIssue is called via createIssueFromTask
      expect(mockCreateIssue).toHaveBeenCalledWith({
        title: 'Create a new feature',
        body: task,
      });
    });

    it('should not create task file when create_issue action is selected', async () => {
      // Given: interactive mode returns create_issue action
      mockDeterminePiece.mockResolvedValue('default');
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'Some task' });
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      await addTask(testDir);

      // Then: no task file created
      const tasksDir = path.join(testDir, '.takt', 'tasks');
      const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
      expect(files.length).toBe(0);
    });

    it('should not prompt for worktree settings when create_issue action is selected', async () => {
      // Given: interactive mode returns create_issue action
      mockDeterminePiece.mockResolvedValue('default');
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'Some task' });
      mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/1' });

      // When
      await addTask(testDir);

      // Then: confirm (worktree prompt) is never called
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });
});
