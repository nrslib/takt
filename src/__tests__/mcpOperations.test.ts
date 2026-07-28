import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueTaktTask,
  listTaktTasks,
  type McpOperationDependencies,
} from '../features/mcp/operations.js';
import type { EnqueueTaskInput } from '../features/mcp/schemas.js';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';

const { noFollowAvailable } = vi.hoisted(() => ({ noFollowAvailable: { value: true } }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NOFOLLOW() {
        if (!noFollowAvailable.value) {
          return undefined;
        }
        if (actual.constants.O_NOFOLLOW === undefined) {
          return actual.constants.O_RDONLY;
        }
        return actual.constants.O_NOFOLLOW;
      },
    },
  };
});

const { mockInitGitProvider, mockGetGitProvider, mockGitProvider } = vi.hoisted(() => {
  const gitProvider = {
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
  };
  return {
    mockInitGitProvider: vi.fn(),
    mockGetGitProvider: vi.fn(() => gitProvider),
    mockGitProvider: gitProvider,
  };
});

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
  getGitProvider: () => mockGetGitProvider(),
}));

const baseInput: EnqueueTaskInput = {
  cwd: '/repo',
  task: 'Implement MCP support',
  workflow: 'default',
  autoPr: false,
};

function text(result: Awaited<ReturnType<typeof enqueueTaktTask>>): string {
  return String(result.content[0]?.text);
}

function json(result: Awaited<ReturnType<typeof enqueueTaktTask>>): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function enqueue(
  extra: Partial<EnqueueTaskInput> = {},
  deps: McpOperationDependencies = {},
  signal?: AbortSignal,
) {
  return enqueueTaktTask({ ...baseInput, ...extra }, deps, signal);
}

function createTaskRecord(overrides: Record<string, unknown>): TaskRecord {
  return TaskRecordSchema.parse({
    name: 'task',
    status: 'pending',
    content: 'Do work',
    created_at: '2026-07-28T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    owner_pid: null,
    ...overrides,
  });
}

function writeTaskHistory(projectDir: string, tasks: TaskRecord[]): string {
  const tasksDir = join(projectDir, '.takt');
  mkdirSync(tasksDir, { recursive: true });
  const tasksFile = join(tasksDir, 'tasks.yaml');
  writeFileSync(tasksFile, stringifyYaml({ tasks }), 'utf-8');
  return tasksFile;
}

function list(projectDir: string, allowedProjectRoot = projectDir) {
  return listTaktTasks({ cwd: projectDir }, { allowedProjectRoot });
}

function parseResult(result: Awaited<ReturnType<typeof listTaktTasks>>): Record<string, unknown> {
  return JSON.parse(String(result.content[0]?.text)) as Record<string, unknown>;
}

describe('MCP enqueue operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitProvider.mockReturnValue(mockGitProvider);
  });

  it('enqueues a normal task without initializing an issue provider', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'normal-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
    });
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('links an existing issue without creating another issue', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'existing-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({ issue: { number: 938 } }, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(json(result)).toEqual(expect.objectContaining({ issueNumber: 938 }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    });
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('creates an issue from the unchanged task body, explicit title, and labels', async () => {
    const task = '\n# Implement MCP support\n\nKeep whitespace.  \n';
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'created-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
    });

    const result = await enqueue({
      task,
      issue: { create: true, title: 'MCP consolidation', labels: ['enhancement'] },
    }, { saveTaskFile, createIssueFromTaskResult });

    expect(result.isError).toBeUndefined();
    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(createIssueFromTaskResult).toHaveBeenCalledWith(task, expect.objectContaining({
      cwd: '/repo',
      explicitTitle: 'MCP consolidation',
      labels: ['enhancement'],
      outputMode: 'silent',
      gitProvider: mockGitProvider,
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', task, {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    });
  });

  it('returns a structured issue creation error and skips saving', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: 'GitHub CLI is not authenticated',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: false,
      taskEnqueued: false,
      stage: 'issue_creation',
      error: 'GitHub CLI is not authenticated',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('keeps a created issue open and returns sanitized retry details when saving fails', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://user:secret@example.test/issues/938?token=secret#fragment',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
      taskEnqueued: false,
      stage: 'task_saving',
      error: 'permission denied',
    });
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('reports issue-number parsing as partial success without an issue number', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      error: 'Failed to extract issue number',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(json(result)).toEqual({
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      taskEnqueued: false,
      stage: 'issue_number_parsing',
      error: 'Failed to extract issue number',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('returns cancellation details after issue creation and does not close the issue', async () => {
    const controller = new AbortController();
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn(() => {
      setImmediate(() => controller.abort());
      return { success: true as const, issueNumber: 938 };
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    }, controller.signal);

    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      taskEnqueued: false,
      stage: 'cancelled_after_issue_creation',
      error: 'Task enqueue was cancelled.',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('sanitizes normal enqueue failures', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Task enqueue failed: permission denied');
  });
});

describe('MCP task listing operation', () => {
  beforeEach(() => {
    noFollowAvailable.value = true;
  });

  it('returns all task statuses with only the approved task fields', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-'));
    try {
      const tasks = [
        createTaskRecord({
          name: 'pending-task',
          workflow: 'default',
          branch: 'feature/list',
          content: 'SECRET pending task body',
        }),
        createTaskRecord({
          name: 'running-task',
          status: 'running',
          workflow: 'backend-mini',
          started_at: '2026-07-28T00:01:00.000Z',
          content: 'SECRET running task body',
        }),
        createTaskRecord({
          name: 'completed-task',
          status: 'completed',
          branch: 'feature/completed',
          started_at: '2026-07-28T00:01:00.000Z',
          completed_at: '2026-07-28T00:02:00.000Z',
          content: 'SECRET completed task body',
        }),
        createTaskRecord({
          name: 'failed-task',
          status: 'failed',
          started_at: '2026-07-28T00:01:00.000Z',
          completed_at: '2026-07-28T00:02:00.000Z',
          failure: { error: 'SECRET failure details' },
          content: 'SECRET failed task body',
        }),
        createTaskRecord({
          name: 'exceeded-task',
          status: 'exceeded',
          started_at: '2026-07-28T00:01:00.000Z',
          completed_at: '2026-07-28T00:02:00.000Z',
          exceeded_max_steps: 10,
          exceeded_current_iteration: 10,
          content: 'SECRET exceeded task body',
        }),
        createTaskRecord({
          name: 'pr-failed-task',
          status: 'pr_failed',
          started_at: '2026-07-28T00:01:00.000Z',
          completed_at: '2026-07-28T00:02:00.000Z',
          content: 'SECRET PR failure task body',
        }),
      ];
      const tasksFile = writeTaskHistory(projectDir, tasks);
      const beforeBytes = readFileSync(tasksFile);
      const beforeMtime = statSync(tasksFile).mtimeMs;

      const result = list(projectDir);

      expect(result.isError).toBeUndefined();
      const payload = parseResult(result);
      expect(payload.summary).toEqual({
        total: 6,
        pending: 1,
        running: 1,
        completed: 1,
        failed: 1,
        exceeded: 1,
        pr_failed: 1,
      });
      expect(payload.tasks).toEqual([
        { name: 'pending-task', status: 'pending', workflow: 'default', branch: 'feature/list' },
        { name: 'running-task', status: 'running', workflow: 'backend-mini' },
        { name: 'completed-task', status: 'completed', branch: 'feature/completed' },
        { name: 'failed-task', status: 'failed' },
        { name: 'exceeded-task', status: 'exceeded' },
        { name: 'pr-failed-task', status: 'pr_failed' },
      ]);
      for (const task of payload.tasks as Array<Record<string, unknown>>) {
        expect(Object.keys(task).every((key) => ['name', 'status', 'workflow', 'branch'].includes(key))).toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('SECRET');
      expect(readFileSync(tasksFile)).toEqual(beforeBytes);
      expect(statSync(tasksFile).mtimeMs).toBe(beforeMtime);
      expect(existsSync(`${tasksFile}.lock`)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns zero history without creating the task storage directory', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-empty-'));
    try {
      const result = list(projectDir);

      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({
        summary: {
          total: 0,
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          exceeded: 0,
          pr_failed: 0,
        },
        tasks: [],
      });
      expect(existsSync(join(projectDir, '.takt'))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns zero history when the task storage file is absent', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-no-file-'));
    try {
      mkdirSync(join(projectDir, '.takt'));

      const result = list(projectDir);

      expect(result.isError).toBeUndefined();
      expect(parseResult(result)).toEqual({
        summary: {
          total: 0,
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          exceeded: 0,
          pr_failed: 0,
        },
        tasks: [],
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a project outside the allowed root without exposing its path', () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-list-root-'));
    const outsideProject = mkdtempSync(join(tmpdir(), 'takt-mcp-list-outside-'));
    try {
      const result = list(outsideProject, allowedRoot);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).not.toContain(outsideProject);
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideProject, { recursive: true, force: true });
    }
  });

  it('returns a stable error for invalid task storage without exposing raw content or paths', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-invalid-'));
    try {
      const tasksFile = writeTaskHistory(projectDir, []);
      writeFileSync(tasksFile, 'tasks: [SECRET malformed task data', 'utf-8');

      const result = list(projectDir);
      const message = String(result.content[0]?.text);

      expect(result.isError).toBe(true);
      expect(message).toBe('Task list failed: Unable to read task history');
      expect(message).not.toContain(projectDir);
      expect(message).not.toContain('SECRET');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('fails safely when the task file is a broken symbolic link', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-link-'));
    try {
      const tasksDir = join(projectDir, '.takt');
      mkdirSync(tasksDir, { recursive: true });
      symlinkSync(join(tasksDir, 'missing-target.yaml'), join(tasksDir, 'tasks.yaml'));

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('fails safely when the task file is a valid symbolic link', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-valid-link-'));
    const sourceProject = mkdtempSync(join(tmpdir(), 'takt-mcp-list-link-source-'));
    try {
      const sourceTasksFile = writeTaskHistory(sourceProject, [createTaskRecord({ name: 'secret-task' })]);
      const tasksDir = join(projectDir, '.takt');
      mkdirSync(tasksDir, { recursive: true });
      symlinkSync(sourceTasksFile, join(tasksDir, 'tasks.yaml'));

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(sourceProject, { recursive: true, force: true });
    }
  });

  it('fails safely when the task directory is a symbolic link', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-parent-link-'));
    const sourceProject = mkdtempSync(join(tmpdir(), 'takt-mcp-list-parent-source-'));
    try {
      writeTaskHistory(sourceProject, [createTaskRecord({ name: 'secret-task' })]);
      symlinkSync(join(sourceProject, '.takt'), join(projectDir, '.takt'), 'dir');

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(sourceProject, { recursive: true, force: true });
    }
  });

  it('fails safely when the task directory is a symbolic link without a task file', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-empty-parent-link-'));
    const sourceProject = mkdtempSync(join(tmpdir(), 'takt-mcp-list-empty-parent-source-'));
    try {
      mkdirSync(join(sourceProject, '.takt'));
      symlinkSync(join(sourceProject, '.takt'), join(projectDir, '.takt'), 'dir');

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(sourceProject, { recursive: true, force: true });
    }
  });

  it('fails safely when the task path is not a regular file', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-non-file-'));
    try {
      const tasksDir = join(projectDir, '.takt');
      mkdirSync(join(tasksDir, 'tasks.yaml'), { recursive: true });

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('fails closed when no-follow file opens are unavailable', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-mcp-list-no-follow-'));
    try {
      writeTaskHistory(projectDir, [createTaskRecord({ name: 'protected-task' })]);
      noFollowAvailable.value = false;

      const result = list(projectDir);

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toBe('Task list failed: Unable to read task history');
    } finally {
      noFollowAvailable.value = true;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
