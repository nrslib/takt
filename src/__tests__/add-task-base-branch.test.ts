/**
 * Tests for base_branch support in task addition (Issue #399)
 *
 * Covers:
 *   - saveTaskFile saves base_branch to tasks.yaml
 *   - promptWorktreeSettings (via addTask/saveTaskFromInteractive):
 *       - main/master branch: no base branch prompt
 *       - feature branch, user confirms: saves base_branch
 *       - feature branch, user declines: no base_branch
 *   - addTask --pr: baseRefName from PR is saved as base_branch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

// --- Hoisted mocks (must be before vi.mock calls) ---

const {
  mockGetCurrentBranch,
  mockCheckCliStatus,
  mockFetchPrReviewComments,
  mockFormatPrReviewAsTask,
  mockDeterminePiece,
} = vi.hoisted(() => ({
  mockGetCurrentBranch: vi.fn().mockReturnValue('main'),
  mockCheckCliStatus: vi.fn().mockReturnValue({ available: true }),
  mockFetchPrReviewComments: vi.fn(),
  mockFormatPrReviewAsTask: vi.fn(),
  mockDeterminePiece: vi.fn().mockResolvedValue('default'),
}));

// --- Module mocks ---

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
  withProgress: vi.fn(async (_start: unknown, _done: unknown, operation: () => Promise<unknown>) => operation()),
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
  determinePiece: (...args: unknown[]) => mockDeterminePiece(...args),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('test-task'),
  // getCurrentBranch will be imported by add/index.ts after implementation
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
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
const mockParseIssueNumbers = vi.fn();

vi.mock('../infra/github/index.js', () => ({
  isIssueReference: (...args: unknown[]) => mockIsIssueReference(...args),
  resolveIssueTask: (...args: unknown[]) => mockResolveIssueTask(...args),
  parseIssueNumbers: (...args: unknown[]) => mockParseIssueNumbers(...args),
  formatPrReviewAsTask: (...args: unknown[]) => mockFormatPrReviewAsTask(...args),
}));

// --- Imports after mocks ---

import { promptInput, confirm } from '../shared/prompt/index.js';
import { saveTaskFile, addTask } from '../features/tasks/index.js';
import type { PrReviewData } from '../infra/git/index.js';

const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);

let testDir: string;

function loadTasks(dir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(dir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

/** Build a mock PrReviewData that includes baseRefName (added in implementation) */
function createMockPrReview(
  overrides: Partial<PrReviewData> & { baseRefName?: string } = {},
): PrReviewData & { baseRefName: string } {
  return {
    number: 456,
    title: 'Fix auth bug',
    body: 'PR description',
    url: 'https://github.com/org/repo/pull/456',
    headRefName: 'feature/fix-auth-bug',
    baseRefName: 'develop',
    comments: [{ author: 'commenter', body: 'Please update tests' }],
    reviews: [{ author: 'reviewer', body: 'Fix null check' }],
    files: ['src/auth.ts'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-base-branch-'));
  mockDeterminePiece.mockResolvedValue('default');
  mockConfirm.mockResolvedValue(false);
  mockCheckCliStatus.mockReturnValue({ available: true });
  mockGetCurrentBranch.mockReturnValue('main');
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

// ---- saveTaskFile with baseBranch ----

describe('saveTaskFile with baseBranch option', () => {
  it('should save base_branch to tasks.yaml when baseBranch option is provided', async () => {
    // Given: baseBranch option is set
    await saveTaskFile(testDir, 'Implement feature X', {
      worktree: true,
      baseBranch: 'feat/base-feature',
    });

    // When: reading tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;

    // Then: base_branch field is written
    expect(task.base_branch).toBe('feat/base-feature');
  });

  it('should not write base_branch to tasks.yaml when baseBranch option is absent', async () => {
    // Given: no baseBranch option
    await saveTaskFile(testDir, 'Implement feature Y', {
      worktree: true,
    });

    // When: reading tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;

    // Then: base_branch field is absent
    expect(task.base_branch).toBeUndefined();
  });

  it('should save base_branch alongside other task options', async () => {
    // Given: multiple options including baseBranch
    await saveTaskFile(testDir, 'Feature Z', {
      piece: 'review',
      worktree: true,
      branch: 'feat/z-branch',
      baseBranch: 'develop',
    });

    // When: reading tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;

    // Then: all fields are saved correctly
    expect(task.base_branch).toBe('develop');
    expect(task.branch).toBe('feat/z-branch');
    expect(task.piece).toBe('review');
    expect(task.worktree).toBe(true);
  });
});

// ---- promptWorktreeSettings via addTask ----

describe('promptWorktreeSettings (via addTask): base branch behavior by current branch', () => {
  it('should NOT prompt for base branch when on main', async () => {
    // Given: user is on main branch
    mockGetCurrentBranch.mockReturnValue('main');
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);  // auto-create PR?

    // When
    await addTask(testDir, 'Task on main');

    // Then: confirm was NOT called with a base branch question
    const baseBranchPrompt = mockConfirm.mock.calls.find(
      ([msg]) => typeof msg === 'string' && (msg as string).toLowerCase().includes('base branch'),
    );
    expect(baseBranchPrompt).toBeUndefined();

    // Then: no base_branch in tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBeUndefined();
  });

  it('should NOT prompt for base branch when on master', async () => {
    // Given: user is on master branch
    mockGetCurrentBranch.mockReturnValue('master');
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);  // auto-create PR?

    // When
    await addTask(testDir, 'Task on master');

    // Then: no base branch confirm prompt
    const baseBranchPrompt = mockConfirm.mock.calls.find(
      ([msg]) => typeof msg === 'string' && (msg as string).toLowerCase().includes('base branch'),
    );
    expect(baseBranchPrompt).toBeUndefined();

    // Then: no base_branch in tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBeUndefined();
  });

  it('should prompt and save base_branch when on feature branch and user confirms', async () => {
    // Given: user is on feat/xxx branch and confirms using it as base
    mockGetCurrentBranch.mockReturnValue('feat/xxx');
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    // Confirm call order: auto-create PR? (false), then base branch confirm (true)
    // Note: actual call order may vary by implementation; key assertion is result
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    // When
    await addTask(testDir, 'Task on feature branch confirmed');

    // Then: base_branch is saved as feat/xxx
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('feat/xxx');
  });

  it('should not save base_branch when on feature branch and user declines', async () => {
    // Given: user is on feat/xxx branch but declines using it as base
    mockGetCurrentBranch.mockReturnValue('feat/xxx');
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    // All confirms decline (covers auto-PR, draft, and base branch)
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir, 'Task on feature branch declined');

    // Then: no base_branch in tasks.yaml
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBeUndefined();
  });

  it('should include current branch name in the base branch confirm message', async () => {
    // Given: user is on feat/my-feature
    mockGetCurrentBranch.mockReturnValue('feat/my-feature');
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    mockConfirm.mockResolvedValue(false);

    // When
    await addTask(testDir, 'Task with named branch in prompt');

    // Then: at least one confirm call included the branch name
    const branchMentionedPrompt = mockConfirm.mock.calls.find(
      ([msg]) => typeof msg === 'string' && (msg as string).includes('feat/my-feature'),
    );
    expect(branchMentionedPrompt).toBeDefined();
  });
});

// ---- addTask --pr: baseRefName from PR → base_branch ----

describe('addTask --pr: baseRefName saved as base_branch', () => {
  it('should save baseRefName from PR as base_branch in tasks.yaml', async () => {
    // Given: PR has baseRefName = 'develop'
    const prReview = createMockPrReview({ baseRefName: 'develop' });
    const formattedTask = '## PR #456 Review: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    // When: addTask with --pr option
    await addTask(testDir, 'placeholder', { prNumber: 456 });

    // Then: base_branch is saved as 'develop'
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('develop');
  });

  it('should save base_branch from PR alongside headRefName as branch', async () => {
    // Given: PR with headRefName and baseRefName
    const prReview = createMockPrReview({
      headRefName: 'feature/fix-auth-bug',
      baseRefName: 'main',
    });
    const formattedTask = '## PR #456 Review: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    // When
    await addTask(testDir, 'placeholder', { prNumber: 456 });

    // Then: branch = headRefName, base_branch = baseRefName
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.branch).toBe('feature/fix-auth-bug');
    expect(task.base_branch).toBe('main');
  });

  it('should not prompt for worktree settings when using --pr', async () => {
    // Given: PR with review comments
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    // When
    await addTask(testDir, 'placeholder', { prNumber: 456 });

    // Then: no prompts for worktree settings (PR sets these automatically)
    expect(mockPromptInput).not.toHaveBeenCalled();
    // getCurrentBranch should NOT be called in PR flow (base branch comes from PR)
    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
  });
});
