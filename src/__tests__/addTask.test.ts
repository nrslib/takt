/**
 * Tests for addTask command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock dependencies before importing the module under test
vi.mock('../commands/interactive.js', () => ({
  interactiveMode: vi.fn(),
}));

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../config/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({ provider: 'claude' })),
}));

vi.mock('../prompt/index.js', () => ({
  promptInput: vi.fn(),
  confirm: vi.fn(),
  selectOption: vi.fn(),
}));

vi.mock('../task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../utils/ui.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../utils/debug.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../config/workflowLoader.js', () => ({
  listWorkflows: vi.fn(),
}));

vi.mock('../config/paths.js', () => ({
  getCurrentWorkflow: vi.fn(() => 'default'),
}));

vi.mock('../github/issue.js', () => ({
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
}));

import { interactiveMode } from '../commands/interactive.js';
import { getProvider } from '../providers/index.js';
import { promptInput, confirm, selectOption } from '../prompt/index.js';
import { summarizeTaskName } from '../task/summarize.js';
import { listWorkflows } from '../config/workflowLoader.js';
import { resolveIssueTask } from '../github/issue.js';
import { addTask, summarizeConversation } from '../commands/addTask.js';

const mockResolveIssueTask = vi.mocked(resolveIssueTask);

const mockInteractiveMode = vi.mocked(interactiveMode);
const mockGetProvider = vi.mocked(getProvider);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockSelectOption = vi.mocked(selectOption);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockListWorkflows = vi.mocked(listWorkflows);

/** Helper: set up mocks for the full happy path */
function setupFullFlowMocks(overrides?: {
  conversationTask?: string;
  summaryContent?: string;
  slug?: string;
}) {
  const task = overrides?.conversationTask ?? 'User: 認証機能を追加したい\n\nAssistant: 了解です。';
  const summary = overrides?.summaryContent ?? '# 認証機能追加\nJWT認証を実装する';
  const slug = overrides?.slug ?? 'add-auth';

  mockInteractiveMode.mockResolvedValue({ confirmed: true, task });

  const mockProviderCall = vi.fn().mockResolvedValue({ content: summary });
  mockGetProvider.mockReturnValue({ call: mockProviderCall } as any);

  mockSummarizeTaskName.mockResolvedValue(slug);
  mockConfirm.mockResolvedValue(false);
  mockListWorkflows.mockReturnValue([]);

  return { mockProviderCall };
}

let testDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-'));
  mockListWorkflows.mockReturnValue([]);
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
    mockInteractiveMode.mockResolvedValue({ confirmed: false, task: '' });

    // When
    await addTask(testDir);

    // Then: no task file created
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
    expect(files.length).toBe(0);
    expect(mockGetProvider).not.toHaveBeenCalled();
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

  it('should summarize conversation via provider.call', async () => {
    // Given
    const { mockProviderCall } = setupFullFlowMocks({
      conversationTask: 'User: バグ修正して\n\nAssistant: どのバグですか？',
    });

    // When
    await addTask(testDir);

    // Then: provider.call was called with conversation text
    expect(mockProviderCall).toHaveBeenCalledWith(
      'task-summarizer',
      'User: バグ修正して\n\nAssistant: どのバグですか？',
      expect.objectContaining({
        cwd: testDir,
        maxTurns: 1,
        allowedTools: [],
      }),
    );
  });

  it('should use first line of summary for filename generation', async () => {
    // Given: summary with multiple lines
    setupFullFlowMocks({
      summaryContent: 'First line summary\nSecond line details',
      slug: 'first-line',
    });

    // When
    await addTask(testDir);

    // Then: summarizeTaskName receives only the first line
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

  it('should include workflow selection in task file', async () => {
    // Given: multiple workflows available
    setupFullFlowMocks({ slug: 'with-workflow' });
    mockListWorkflows.mockReturnValue(['default', 'review']);
    mockConfirm.mockResolvedValue(false);
    mockSelectOption.mockResolvedValue('review');

    // When
    await addTask(testDir);

    // Then
    const taskFile = path.join(testDir, '.takt', 'tasks', 'with-workflow.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('workflow: review');
  });

  it('should cancel when workflow selection returns null', async () => {
    // Given: workflows available but user cancels selection
    setupFullFlowMocks({ slug: 'cancelled' });
    mockListWorkflows.mockReturnValue(['default', 'review']);
    mockConfirm.mockResolvedValue(false);
    mockSelectOption.mockResolvedValue(null);

    // When
    await addTask(testDir);

    // Then: no task file created (cancelled at workflow selection)
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(0);
  });

  it('should not include workflow when current workflow is selected', async () => {
    // Given: current workflow selected (no need to record it)
    setupFullFlowMocks({ slug: 'default-wf' });
    mockListWorkflows.mockReturnValue(['default', 'review']);
    mockConfirm.mockResolvedValue(false);
    mockSelectOption.mockResolvedValue('default');

    // When
    await addTask(testDir);

    // Then: workflow field should not be in the YAML
    const taskFile = path.join(testDir, '.takt', 'tasks', 'default-wf.yaml');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).not.toContain('workflow:');
  });

  it('should fetch issue and use directly as task content when given issue reference', async () => {
    // Given: issue reference "#99"
    const issueText = 'Issue #99: Fix login timeout\n\nThe login page times out after 30 seconds.';
    mockResolveIssueTask.mockReturnValue(issueText);

    mockSummarizeTaskName.mockResolvedValue('fix-login-timeout');
    mockConfirm.mockResolvedValue(false);
    mockListWorkflows.mockReturnValue([]);

    // When
    await addTask(testDir, '#99');

    // Then: interactiveMode should NOT be called
    expect(mockInteractiveMode).not.toHaveBeenCalled();

    // Then: resolveIssueTask was called
    expect(mockResolveIssueTask).toHaveBeenCalledWith('#99');

    // Then: task file created with issue text directly (no AI summarization)
    const taskFile = path.join(testDir, '.takt', 'tasks', 'fix-login-timeout.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('Fix login timeout');
  });

  it('should proceed to worktree/workflow settings after issue fetch', async () => {
    // Given: issue with worktree enabled
    mockResolveIssueTask.mockReturnValue('Issue text');
    mockSummarizeTaskName.mockResolvedValue('issue-task');
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValue('');
    mockListWorkflows.mockReturnValue([]);

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

    // Then: no task file created, no crash
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(0);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('should include issue number in task file when issue reference is used', async () => {
    // Given: issue reference "#99"
    const issueText = 'Issue #99: Fix login timeout';
    mockResolveIssueTask.mockReturnValue(issueText);
    mockSummarizeTaskName.mockResolvedValue('fix-login-timeout');
    mockConfirm.mockResolvedValue(false);
    mockListWorkflows.mockReturnValue([]);

    // When
    await addTask(testDir, '#99');

    // Then: task file contains issue field
    const taskFile = path.join(testDir, '.takt', 'tasks', 'fix-login-timeout.yaml');
    expect(fs.existsSync(taskFile)).toBe(true);
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('issue: 99');
  });
});

describe('summarizeConversation', () => {
  it('should call provider with summarize system prompt', async () => {
    // Given
    const mockCall = vi.fn().mockResolvedValue({ content: 'Summary text' });
    mockGetProvider.mockReturnValue({ call: mockCall } as any);

    // When
    const result = await summarizeConversation('/project', 'conversation text');

    // Then
    expect(result).toBe('Summary text');
    expect(mockCall).toHaveBeenCalledWith(
      'task-summarizer',
      'conversation text',
      expect.objectContaining({
        cwd: '/project',
        maxTurns: 1,
        allowedTools: [],
        systemPrompt: expect.stringContaining('会話履歴からタスクの要件をまとめてください'),
      }),
    );
  });
});
