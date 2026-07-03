import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIssueAndEnqueueTaktTask,
  enqueueTaktTask,
  type McpOperationDependencies,
  runNextTaktTask,
} from '../features/mcp/operations.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';

vi.mock('../infra/task/summarize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('implement-mcp-support'),
}));

const {
  mockCreateIssue,
  mockCloseIssue,
  mockInitGitProvider,
  mockIssueInfo,
  mockIssueSuccess,
  mockIssueError,
  mockGitProvider,
  mockGetGitProvider,
} = vi.hoisted(() => {
  const gitProvider = {
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
  };
  return {
  mockCreateIssue: vi.fn(),
  mockCloseIssue: vi.fn(),
  mockInitGitProvider: vi.fn(),
  mockIssueInfo: vi.fn(),
    mockIssueSuccess: vi.fn(),
    mockIssueError: vi.fn(),
    mockGitProvider: gitProvider,
    mockGetGitProvider: vi.fn(() => gitProvider),
  };
});

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
  getGitProvider: () => mockGetGitProvider(),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: (...args: unknown[]) => mockIssueInfo(...args),
  success: (...args: unknown[]) => mockIssueSuccess(...args),
  error: (...args: unknown[]) => mockIssueError(...args),
}));

type ToolTextContent = {
  type: 'text';
  text: string;
};

type ToolResult = {
  isError?: boolean;
  content: ToolTextContent[];
};

function asToolResult(result: unknown): ToolResult {
  return result as ToolResult;
}

function getToolText(result: unknown): string {
  return asToolResult(result).content.map((item) => item.text).join('\n');
}

function parseToolJson(result: unknown): Record<string, unknown> {
  return JSON.parse(getToolText(result)) as Record<string, unknown>;
}

const RAW_LOCAL_ERROR = "EACCES: permission denied, open '/Users/nrs/secret/.takt/tasks.yaml'";

function expectNoRawLocalError(result: unknown): void {
  const text = getToolText(result);
  expect(text).not.toContain('/Users/nrs/secret');
  expect(text).not.toContain('.takt/tasks.yaml');
  expect(text).not.toContain('EACCES');
}

function loadTasks(cwd: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function createTask(name: string): TaskInfo {
  return {
    name,
    content: `Task: ${name}`,
    filePath: `/repo/.takt/tasks/${name}.yaml`,
    createdAt: '2026-07-02T00:00:00.000Z',
    status: 'running',
    data: {
      task: `Task: ${name}`,
      workflow: 'default',
    },
  };
}

describe('MCP task operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitProvider.createIssue.mockImplementation((...args: unknown[]) => mockCreateIssue(...args));
    mockGitProvider.closeIssue.mockImplementation((...args: unknown[]) => mockCloseIssue(...args));
    mockGetGitProvider.mockReturnValue(mockGitProvider);
  });

  it('Given minimal enqueue input, When takt_enqueue_task runs, Then saveTaskFile receives MCP defaults', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260702-add-mcp',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
    });
    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result)).toEqual({
      taskName: '20260702-add-mcp',
      tasksFile: '/repo/.takt/tasks.yaml',
      workflow: 'default',
    });
  });

  it('Given real enqueue dependencies, When takt_enqueue_task runs, Then a pending task file and order are created', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-enqueue-'));
    try {
      const result = await enqueueTaktTask({
        cwd,
        task: 'Implement MCP support\n\nUse the existing task storage path.',
        workflow: 'review',
        worktree: true,
        autoPr: true,
        taskContext: {
          branch: 'takt/938/add-mcp',
          baseBranch: 'main',
        },
      });

      const parsedResult = parseToolJson(result);
      const task = loadTasks(cwd).tasks[0];
      const taskDir = join(cwd, String(task?.task_dir));

      expect(result.isError).toBeUndefined();
      expect(parsedResult.tasksFile).toBe(join(cwd, '.takt', 'tasks.yaml'));
      expect(parsedResult.workflow).toBe('review');
      expect(task).toEqual(expect.objectContaining({
        workflow: 'review',
        worktree: true,
        branch: 'takt/938/add-mcp',
        base_branch: 'main',
        auto_pr: true,
        slug: 'implement-mcp-support',
      }));
      expect(existsSync(join(taskDir, 'order.md'))).toBe(true);
      expect(readFileSync(join(taskDir, 'order.md'), 'utf-8')).toContain('Implement MCP support');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given explicit task options, When takt_enqueue_task runs, Then options reach task saving', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260702-add-mcp',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
      workflow: 'review',
      worktree: true,
      autoPr: true,
      taskContext: {
        branch: 'takt/938/add-mcp',
        baseBranch: 'main',
        prNumber: 938,
      },
    }, { saveTaskFile });

    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', {
      workflow: 'review',
      worktree: true,
      autoPr: true,
      branch: 'takt/938/add-mcp',
      baseBranch: 'main',
      contextPrNumber: 938,
    });
  });

  it('Given PR context on normal enqueue, When the task is saved, Then it does not become PR review provenance', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-pr-context-'));
    try {
      const result = await enqueueTaktTask({
        cwd,
        task: 'Implement MCP support',
        taskContext: {
          prNumber: 938,
        },
      });
      const task = loadTasks(cwd).tasks[0];

      expect(result.isError).toBeUndefined();
      expect(task).toMatchObject({
        context_pr_number: 938,
        workflow: 'default',
      });
      expect(task).not.toHaveProperty('source');
      expect(task).not.toHaveProperty('pr_number');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given real issue and task dependencies, When issue creation succeeds, Then the task is saved with the issue number', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-issue-enqueue-'));
    mockCreateIssue.mockReturnValue({
      success: true,
      issueNumber: 938,
      url: 'https://github.com/nrslib/takt/issues/938',
    });

    try {
      const result = await createIssueAndEnqueueTaktTask({
        cwd,
        task: 'Implement MCP support\n\nUse the existing task storage path.',
        labels: ['enhancement', 'mcp'],
      });
      const task = loadTasks(cwd).tasks[0];

      expect(mockInitGitProvider).toHaveBeenCalledWith(cwd);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        {
          title: 'Implement MCP support',
          body: 'Implement MCP support\n\nUse the existing task storage path.',
          labels: ['enhancement', 'mcp'],
        },
        cwd,
      );
      expect(result.isError).toBeUndefined();
      expect(parseToolJson(result)).toMatchObject({
        tasksFile: join(cwd, '.takt', 'tasks.yaml'),
        workflow: 'default',
        issueNumber: 938,
      });
      expect(task).toEqual(expect.objectContaining({
        issue: 938,
        workflow: 'default',
        worktree: true,
        auto_pr: false,
        slug: 'implement-mcp-support',
      }));
      expect(mockIssueInfo).not.toHaveBeenCalled();
      expect(mockIssueSuccess).not.toHaveBeenCalled();
      expect(mockIssueError).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given boundary whitespace in task content, When issue enqueue runs, Then issue body and saved order preserve the original body', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-issue-body-'));
    const taskBody = '\n# Implement MCP support\n\nKeep trailing whitespace.  \n';
    mockCreateIssue.mockReturnValue({
      success: true,
      issueNumber: 938,
      url: 'https://github.com/nrslib/takt/issues/938',
    });

    try {
      const result = await createIssueAndEnqueueTaktTask({
        cwd,
        task: taskBody,
        labels: ['mcp'],
      });
      const task = loadTasks(cwd).tasks[0];
      const taskDir = join(cwd, String(task?.task_dir));

      expect(result.isError).toBeUndefined();
      expect(mockCreateIssue).toHaveBeenCalledWith(
        {
          title: 'Implement MCP support',
          body: taskBody,
          labels: ['mcp'],
        },
        cwd,
      );
      expect(readFileSync(join(taskDir, 'order.md'), 'utf-8')).toBe(taskBody);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given issue enqueue input, When issue creation fails, Then saving is skipped and an MCP error is returned', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: 'GitHub CLI is not authenticated',
    });
    const saveTaskFile = vi.fn();

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('GitHub CLI is not authenticated');
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('Given issue enqueue cwd outside the MCP root, When the operation runs, Then issue creation and saving are skipped', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-allowed-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-outside-'));
    const createIssueFromTaskResult = vi.fn();
    const saveTaskFile = vi.fn();

    try {
      const result = await createIssueAndEnqueueTaktTask({
        cwd: outsideRoot,
        task: 'Implement MCP support',
      }, {
        allowedProjectRoot: allowedRoot,
        createIssueFromTaskResult,
        saveTaskFile,
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain('outside the allowed project root');
      expect(mockInitGitProvider).not.toHaveBeenCalled();
      expect(createIssueFromTaskResult).not.toHaveBeenCalled();
      expect(saveTaskFile).not.toHaveBeenCalled();
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('Given issue creation fails with a local error, When issue enqueue runs, Then the MCP error does not expose the raw error', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: RAW_LOCAL_ERROR,
    });
    const saveTaskFile = vi.fn();

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toBe('permission denied');
    expectNoRawLocalError(result);
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('Given real issue creation fails, When issue enqueue runs, Then saving is skipped and UI output stays silent', async () => {
    mockCreateIssue.mockReturnValue({
      success: false,
      error: 'GitHub CLI is not authenticated',
    });
    const saveTaskFile = vi.fn();

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
      labels: ['enhancement'],
    }, { saveTaskFile });

    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(mockCreateIssue).toHaveBeenCalledWith(
      {
        title: 'Implement MCP support',
        body: 'Implement MCP support',
        labels: ['enhancement'],
      },
      '/repo',
    );
    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('GitHub CLI is not authenticated');
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(mockIssueInfo).not.toHaveBeenCalled();
    expect(mockIssueSuccess).not.toHaveBeenCalled();
    expect(mockIssueError).not.toHaveBeenCalled();
  });

  it('Given issue creation succeeds but task saving fails, When issue enqueue runs, Then the created issue is closed', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    const compensateCreatedIssue: NonNullable<McpOperationDependencies['compensateCreatedIssue']> = vi.fn((input) => {
      expect(input.stage).toBe('task_saving');
      return { success: true };
    });

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile, compensateCreatedIssue });

    expect(result.isError).toBe(true);
    expect(compensateCreatedIssue).toHaveBeenCalledWith({
      cwd: '/repo',
      gitProvider: mockGitProvider,
      issueNumber: 938,
      stage: 'task_saving',
    });
    expect(getToolText(result)).toContain('Issue #938 was created and closed');
    expect(getToolText(result)).toContain('task saving failed: permission denied');
  });

  it('Given default compensation, When task saving fails after issue creation, Then the Git provider closes the issue without raw local errors', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error(RAW_LOCAL_ERROR),
    );
    mockCloseIssue.mockReturnValue({ success: true });

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile });

    expect(result.isError).toBe(true);
    expect(mockCloseIssue).toHaveBeenCalledWith(
      938,
      [
        'TAKT created this issue, but saving the pending task failed.',
        '',
        'The issue is being closed to keep the repository state consistent.',
      ].join('\n'),
      '/repo',
    );
    const compensationComment = String(mockCloseIssue.mock.calls[0]?.[1]);
    expect(compensationComment).not.toContain('/Users/nrs/secret');
    expect(compensationComment).not.toContain('EACCES');
    expect(getToolText(result)).toContain('task saving failed: permission denied');
    expectNoRawLocalError(result);
  });

  it('Given default compensation fails with a local error, When task saving fails after issue creation, Then both MCP errors are sanitized', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    mockCloseIssue.mockReturnValue({
      success: false,
      error: RAW_LOCAL_ERROR,
    });

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile });

    expect(result.isError).toBe(true);
    expect(mockCloseIssue).toHaveBeenCalledWith(
      938,
      expect.stringContaining('TAKT created this issue'),
      '/repo',
    );
    expect(getToolText(result)).toContain('Issue #938 was created, but task saving failed');
    expect(getToolText(result)).toContain('task saving failed: permission denied');
    expect(getToolText(result)).toContain('Issue close failed: permission denied');
    expectNoRawLocalError(result);
  });

  it('Given the global provider changes while saving, When compensation runs, Then the request provider closes the issue', async () => {
    const requestProvider = {
      createIssue: vi.fn(),
      closeIssue: vi.fn().mockReturnValue({ success: true }),
    };
    const laterProvider = {
      createIssue: vi.fn(),
      closeIssue: vi.fn().mockReturnValue({ success: true }),
    };
    mockGetGitProvider.mockReturnValueOnce(requestProvider).mockReturnValue(laterProvider);
    const saveTaskFile = vi.fn().mockImplementation(async () => {
      throw new Error('EACCES: permission denied');
    });
    requestProvider.createIssue.mockReturnValue({
      success: true,
      issueNumber: 938,
    });

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(requestProvider.createIssue).toHaveBeenCalledTimes(1);
    expect(requestProvider.closeIssue).toHaveBeenCalledWith(
      938,
      expect.stringContaining('TAKT created this issue'),
      '/repo',
    );
    expect(laterProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('Given concurrent issue enqueue requests, When task saving fails, Then each request provider closes its own issue', async () => {
    const firstProvider = {
      createIssue: vi.fn().mockReturnValue({ success: true, issueNumber: 101 }),
      closeIssue: vi.fn().mockReturnValue({ success: true }),
    };
    const secondProvider = {
      createIssue: vi.fn().mockReturnValue({ success: true, issueNumber: 202 }),
      closeIssue: vi.fn().mockReturnValue({ success: true }),
    };
    const fallbackProvider = {
      createIssue: vi.fn().mockReturnValue({ success: true, issueNumber: 303 }),
      closeIssue: vi.fn().mockReturnValue({ success: true }),
    };
    mockGetGitProvider
      .mockReturnValueOnce(firstProvider)
      .mockReturnValueOnce(secondProvider)
      .mockReturnValue(fallbackProvider);
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));

    const [firstResult, secondResult] = await Promise.all([
      createIssueAndEnqueueTaktTask({
        cwd: '/repo-a',
        task: 'Implement first MCP task',
      }, { saveTaskFile }),
      createIssueAndEnqueueTaktTask({
        cwd: '/repo-b',
        task: 'Implement second MCP task',
      }, { saveTaskFile }),
    ]);

    expect(firstResult.isError).toBe(true);
    expect(secondResult.isError).toBe(true);
    expect(firstProvider.createIssue).toHaveBeenCalledTimes(1);
    expect(secondProvider.createIssue).toHaveBeenCalledTimes(1);
    expect(firstProvider.closeIssue).toHaveBeenCalledWith(
      101,
      expect.stringContaining('TAKT created this issue'),
      '/repo-a',
    );
    expect(secondProvider.closeIssue).toHaveBeenCalledWith(
      202,
      expect.stringContaining('TAKT created this issue'),
      '/repo-b',
    );
    expect(fallbackProvider.createIssue).not.toHaveBeenCalled();
    expect(fallbackProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('Given a URL appears in an MCP error, When it is sanitized, Then the URL is not treated as a local path', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error('Request failed for https://example.com/path'),
    );

    const result = await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('https://example.com/path');
  });

  it('Given secrets and a file URL appear in an MCP error, When it is sanitized, Then secrets and local paths are redacted', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error(
        'Request failed\n' +
        'Authorization: Bearer ghp_123456789\n' +
        'api_key=plain-secret\n' +
        'https://user:pass@example.com/repo\n' +
        'file:///Users/nrs/secret/token.txt',
      ),
    );

    const result = await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    const text = getToolText(result);
    expect(result.isError).toBe(true);
    expect(text).toContain('Authorization: Bearer [REDACTED]');
    expect(text).toContain('api_key=[REDACTED]');
    expect(text).toContain('https://[REDACTED]@example.com/repo');
    expect(text).toContain('[path]');
    expect(text).not.toContain('ghp_123456789');
    expect(text).not.toContain('plain-secret');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('/Users/nrs/secret');
    expect(text).not.toContain('file:///Users/nrs/secret');
  });

  it('Given a file URL appears in an MCP error, When it is sanitized, Then the local path is not exposed', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error('Cannot read file:///Users/nrs/secret/order.md'),
    );

    const result = await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toBe('Task saving failed: Cannot read [path]');
    expect(getToolText(result)).not.toContain('file:///Users/nrs/secret');
    expect(getToolText(result)).not.toContain('/Users/nrs/secret');
  });

  it('Given issue close compensation fails, When task saving fails after issue creation, Then both failures are returned', async () => {
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    const compensateCreatedIssue = vi.fn().mockReturnValue({
      success: false,
      commentCreated: true,
      error: 'GitHub CLI is not authenticated',
    });

    const result = await createIssueAndEnqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { createIssueFromTaskResult, saveTaskFile, compensateCreatedIssue });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('Issue #938 was created, but task saving failed');
    expect(getToolText(result)).toContain('task saving failed: permission denied');
    expect(getToolText(result)).toContain(
      'Issue compensation comment was created, but issue close failed: GitHub CLI is not authenticated',
    );
  });

  it('Given task saving fails with a local path, When enqueue runs, Then the MCP error does not expose the path', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error(RAW_LOCAL_ERROR),
    );

    const result = await enqueueTaktTask({
      cwd: '/repo',
      task: 'Implement MCP support',
    }, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toBe('Task saving failed: permission denied');
    expectNoRawLocalError(result);
  });

  it('Given one pending task, When takt_run_next_task runs, Then only that task reaches the existing execution path', async () => {
    const task = createTask('20260702-add-mcp');
    const taskRunner = {
      failInterruptedRunningTasks: vi.fn(() => 0),
      claimNextTasks: vi.fn(() => [task]),
    };
    const createTaskRunner = vi.fn(() => taskRunner);
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({ success: true });

    const result = await runNextTaktTask({
      cwd: '/repo',
      provider: 'mock',
      model: 'mock-model',
      taskContext: {
        branch: 'takt/938/add-mcp',
        baseBranch: 'main',
        prNumber: 938,
      },
    }, { createTaskRunner, executeRunTaskAndCompleteWithDetails });

    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(createTaskRunner).toHaveBeenCalledWith('/repo');
    expect(taskRunner.failInterruptedRunningTasks).toHaveBeenCalledTimes(1);
    expect(taskRunner.claimNextTasks).toHaveBeenCalledWith(1);
    expect(executeRunTaskAndCompleteWithDetails).toHaveBeenCalledWith(
      task,
      taskRunner,
      '/repo',
      {
        provider: 'mock',
        model: 'mock-model',
      },
      expect.objectContaining({
        outputMode: 'silent',
      }),
      {
        gitProvider: mockGitProvider,
        taskContext: {
          branch: 'takt/938/add-mcp',
          baseBranch: 'main',
          prNumber: 938,
        },
      },
    );
    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result)).toMatchObject({
      ran: true,
      taskName: '20260702-add-mcp',
      success: true,
    });
  });

  it('Given concurrent run-next requests, When tasks execute, Then each execution receives its request provider', async () => {
    const firstProvider = { name: 'first-provider' };
    const secondProvider = { name: 'second-provider' };
    mockGetGitProvider
      .mockReturnValueOnce(firstProvider)
      .mockReturnValueOnce(secondProvider);
    const firstTask = createTask('20260702-first-mcp-task');
    const secondTask = createTask('20260702-second-mcp-task');
    const taskRunnersByCwd = new Map([
      ['/repo-a', {
        failInterruptedRunningTasks: vi.fn(() => 0),
        claimNextTasks: vi.fn(() => [firstTask]),
      }],
      ['/repo-b', {
        failInterruptedRunningTasks: vi.fn(() => 0),
        claimNextTasks: vi.fn(() => [secondTask]),
      }],
    ]);
    const createTaskRunner = vi.fn((cwd: string) => {
      const taskRunner = taskRunnersByCwd.get(cwd);
      if (!taskRunner) {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }
      return taskRunner;
    });
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({ success: true });

    const [firstResult, secondResult] = await Promise.all([
      runNextTaktTask({
        cwd: '/repo-a',
      }, { createTaskRunner, executeRunTaskAndCompleteWithDetails }),
      runNextTaktTask({
        cwd: '/repo-b',
      }, { createTaskRunner, executeRunTaskAndCompleteWithDetails }),
    ]);

    expect(firstResult.isError).toBeUndefined();
    expect(secondResult.isError).toBeUndefined();
    expect(executeRunTaskAndCompleteWithDetails).toHaveBeenCalledTimes(2);
    expect(executeRunTaskAndCompleteWithDetails.mock.calls[0]?.[5]).toEqual({
      gitProvider: firstProvider,
    });
    expect(executeRunTaskAndCompleteWithDetails.mock.calls[1]?.[5]).toEqual({
      gitProvider: secondProvider,
    });
  });

  it('Given a real pending task file, When takt_run_next_task runs, Then real TaskRunner claims the task before execution', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-run-next-'));
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({ success: true });

    try {
      await enqueueTaktTask({
        cwd,
        task: 'Implement MCP support\n\nRun through the real task runner.',
        workflow: 'review',
      });

      const result = await runNextTaktTask({
        cwd,
        provider: 'mock',
      }, { executeRunTaskAndCompleteWithDetails });
      const persistedTask = loadTasks(cwd).tasks[0];
      const executedTask = executeRunTaskAndCompleteWithDetails.mock.calls[0]?.[0] as TaskInfo | undefined;
      const taskRunner = executeRunTaskAndCompleteWithDetails.mock.calls[0]?.[1] as TaskRunner | undefined;

      expect(mockInitGitProvider).toHaveBeenCalledWith(cwd);
      expect(executeRunTaskAndCompleteWithDetails).toHaveBeenCalledTimes(1);
      expect(executedTask).toEqual(expect.objectContaining({
        name: persistedTask?.name,
        status: 'running',
      }));
      expect(taskRunner).toBeInstanceOf(TaskRunner);
      expect(persistedTask).toEqual(expect.objectContaining({
        status: 'running',
        workflow: 'review',
        owner_pid: process.pid,
      }));
      expect(parseToolJson(result)).toMatchObject({
        ran: true,
        taskName: persistedTask?.name,
        success: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given no pending task, When takt_run_next_task runs, Then it returns ran false', async () => {
    const taskRunner = {
      failInterruptedRunningTasks: vi.fn(() => 0),
      claimNextTasks: vi.fn(() => []),
    };
    const executeRunTaskAndCompleteWithDetails = vi.fn();

    const result = await runNextTaktTask({
      cwd: '/repo',
    }, {
      createTaskRunner: vi.fn(() => taskRunner),
      executeRunTaskAndCompleteWithDetails,
    });

    expect(executeRunTaskAndCompleteWithDetails).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result)).toEqual({
      ran: false,
      message: 'No pending tasks in .takt/tasks.yaml',
    });
  });

  it('Given run-next cwd outside the MCP root, When the operation runs, Then task claim and execution are skipped', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-allowed-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-outside-'));
    const createTaskRunner = vi.fn();
    const executeRunTaskAndCompleteWithDetails = vi.fn();

    try {
      const result = await runNextTaktTask({
        cwd: outsideRoot,
      }, {
        allowedProjectRoot: allowedRoot,
        createTaskRunner,
        executeRunTaskAndCompleteWithDetails,
      });

      expect(result.isError).toBe(true);
      expect(getToolText(result)).toContain('outside the allowed project root');
      expect(mockInitGitProvider).not.toHaveBeenCalled();
      expect(createTaskRunner).not.toHaveBeenCalled();
      expect(executeRunTaskAndCompleteWithDetails).not.toHaveBeenCalled();
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('Given a claimed task, When execution fails, Then an MCP error result includes the failure reason', async () => {
    const task = createTask('20260702-add-mcp');
    const taskRunner = {
      failInterruptedRunningTasks: vi.fn(() => 0),
      claimNextTasks: vi.fn(() => [task]),
    };
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({
      success: false,
      failureReason: RAW_LOCAL_ERROR,
    });

    const result = await runNextTaktTask({
      cwd: '/repo',
    }, {
      createTaskRunner: vi.fn(() => taskRunner),
      executeRunTaskAndCompleteWithDetails,
    });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('20260702-add-mcp');
    expect(getToolText(result)).toContain('permission denied');
    expectNoRawLocalError(result);
  });

  it('Given a claimed task, When PR post-execution fails, Then an MCP error result includes the PR failure reason', async () => {
    const task = createTask('20260702-add-mcp');
    const taskRunner = {
      failInterruptedRunningTasks: vi.fn(() => 0),
      claimNextTasks: vi.fn(() => [task]),
    };
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({
      success: true,
      prFailed: true,
      postExecutionFailureReason: RAW_LOCAL_ERROR,
    });

    const result = await runNextTaktTask({
      cwd: '/repo',
    }, {
      createTaskRunner: vi.fn(() => taskRunner),
      executeRunTaskAndCompleteWithDetails,
    });

    expect(result.isError).toBe(true);
    expect(getToolText(result)).toContain('20260702-add-mcp');
    expect(getToolText(result)).toContain('permission denied');
    expectNoRawLocalError(result);
  });
});
