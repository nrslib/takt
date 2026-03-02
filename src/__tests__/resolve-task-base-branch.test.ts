/**
 * Integration tests for resolveTaskExecution with base_branch (Issue #399)
 *
 * Verifies that base_branch from task data is propagated to createSharedClone
 * as baseBranch option, crossing the following module chain:
 *   resolveTaskExecution (execute/resolveTask.ts)
 *     → createSharedClone (infra/task/clone.ts)
 *       → CloneManager.resolveBaseBranch (infra/task/clone.ts)
 *
 * Tests follow the integration-test criteria:
 *   - 3+ modules crossed in the call chain
 *   - New option (base_branch) propagates from task data to clone creation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskInfo } from '../infra/task/index.js';

// --- Hoisted mocks ---

const { mockCreateSharedClone, mockWithProgress } = vi.hoisted(() => ({
  mockCreateSharedClone: vi.fn(),
  mockWithProgress: vi.fn(async (
    _start: unknown,
    _done: unknown,
    operation: () => Promise<unknown>,
  ) => operation()),
}));

// --- Module mocks ---

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSharedClone: (...args: unknown[]) => mockCreateSharedClone(...args),
  summarizeTaskName: vi.fn().mockResolvedValue('test-task'),
  detectDefaultBranch: vi.fn().mockReturnValue('main'),
  resolveBaseBranch: vi.fn((_cwd: unknown, taskBranch?: string) => ({ branch: taskBranch ?? 'main' })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  withProgress: (...args: unknown[]) => mockWithProgress(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  resolvePieceConfigValue: vi.fn(() => undefined),
  resolveConfigValue: vi.fn(() => undefined),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: vi.fn(() => ({ available: false })),
    fetchIssue: vi.fn(),
  }),
}));

// --- Import under test ---

import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';

// --- Helpers ---

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-base-branch-test-'));
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

beforeEach(() => {
  vi.clearAllMocks();

  // Default: createSharedClone succeeds
  mockCreateSharedClone.mockReturnValue({ path: '/tmp/clone', branch: 'takt/123/test-task' });
});

// ---- Integration tests ----

describe('resolveTaskExecution propagates base_branch to createSharedClone', () => {
  it('should pass base_branch from task data to createSharedClone as baseBranch option', async () => {
    // Given: task has base_branch set in data
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run task with base branch',
        worktree: true,
        base_branch: 'feat/xxx',
      },
    });

    // When
    await resolveTaskExecution(task, root, 'default');

    // Then: createSharedClone was called with baseBranch option
    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        baseBranch: 'feat/xxx',
      }),
    );
  });

  it('should NOT pass baseBranch to createSharedClone when base_branch is absent', async () => {
    // Given: task has no base_branch in data
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run task without base branch',
        worktree: true,
      },
    });

    // When
    await resolveTaskExecution(task, root, 'default');

    // Then: createSharedClone was called without baseBranch (or with undefined)
    const callArgs = mockCreateSharedClone.mock.calls[0];
    const options = callArgs?.[1] as Record<string, unknown>;
    // baseBranch should be absent or undefined — not a specific branch
    expect(options?.baseBranch).toBeUndefined();
  });

  it('should reflect baseBranch from task data in resolved baseBranch output', async () => {
    // Given: task specifies base_branch and createSharedClone succeeds
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run task',
        worktree: true,
        base_branch: 'feat/feature-branch',
      },
    });
    mockCreateSharedClone.mockReturnValue({ path: '/tmp/clone', branch: 'takt/123/run-task' });

    // When
    const result = await resolveTaskExecution(task, root, 'default');

    // Then: the resolved baseBranch in the result matches the task's base_branch
    expect(result.baseBranch).toBe('feat/feature-branch');
  });

  it('should still work when worktree is false and base_branch is set (base_branch ignored)', async () => {
    // Given: worktree is disabled; base_branch is provided but irrelevant
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run non-worktree task',
        base_branch: 'feat/xxx',
      },
    });

    // When
    const result = await resolveTaskExecution(task, root, 'default');

    // Then: execCwd is the project root (no worktree)
    expect(result.execCwd).toBe(root);
    expect(result.isWorktree).toBe(false);
    // Then: createSharedClone is NOT called
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
  });

  it('should use task.base_branch over config default branch when resolving baseBranch', async () => {
    // Given: both task.base_branch and resolveBaseBranch-from-config would return different values
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run task with explicit base',
        worktree: true,
        base_branch: 'feat/explicit-base',
      },
    });

    // When
    await resolveTaskExecution(task, root, 'default');

    // Then: createSharedClone received the explicit base_branch value
    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        baseBranch: 'feat/explicit-base',
      }),
    );
    // Not the mock's detectDefaultBranch return value of 'main'
    const callOptions = mockCreateSharedClone.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callOptions?.baseBranch).not.toBe('main');
  });
});
