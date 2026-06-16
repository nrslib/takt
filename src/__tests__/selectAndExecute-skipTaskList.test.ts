/**
 * Tests for skipTaskList option in selectAndExecuteTask
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateExecutionReportDir } from '../core/workflow/run/run-slug.js';
import { generateReportDir } from '../shared/utils/reportDir.js';

const {
  mockAddTask,
  mockExecuteTask,
  mockPersistTaskResult,
  mockPersistTaskError,
  mockBuildBooleanTaskResult,
} = vi.hoisted(() => ({
  mockAddTask: vi.fn(() => ({
    name: 'test-task',
    content: 'test task',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-02-14T00:00:00.000Z',
    status: 'pending',
    data: { task: 'test task' },
  })),
  mockExecuteTask: vi.fn(),
  mockPersistTaskResult: vi.fn(),
  mockPersistTaskError: vi.fn(),
  mockBuildBooleanTaskResult: vi.fn(() => ({ task: 'mock-result' })),
}));

vi.mock('../shared/prompt/index.js', () => ({
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValue: vi.fn(),
  loadWorkflowByIdentifier: vi.fn(() => ({ name: 'default' })),
  listWorkflows: vi.fn(() => ['default']),
  listWorkflowEntries: vi.fn(() => []),
  isWorkflowPath: vi.fn(() => false),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  buildTaskInstruction: vi.fn((_taskDir: string, orderFile: string) => `Primary spec: \`${orderFile}\`.`),
  TaskRunner: vi.fn(() => ({
    addTask: (...args: unknown[]) => mockAddTask(...args),
  })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  withProgress: async <T>(
    _startMessage: string,
    _completionMessage: string | ((result: T) => string),
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  buildPrBody: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
}));

vi.mock('../features/tasks/execute/taskResultHandler.js', () => ({
  buildBooleanTaskResult: (...args: unknown[]) => mockBuildBooleanTaskResult(...args),
  persistTaskResult: (...args: unknown[]) => mockPersistTaskResult(...args),
  persistTaskError: (...args: unknown[]) => mockPersistTaskError(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: vi.fn(),
}));

import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';

const tempRoots = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteTask.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-select-execute-test-'));
  tempRoots.add(root);
  return root;
}

describe('skipTaskList option in selectAndExecuteTask', () => {
  it('skipTaskList: true の場合はタスクリストに追加しない', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
      skipTaskList: true,
    });

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList: true の直接実行では trace task context を executeTask metadata に変換する', async () => {
    const options = {
      workflow: 'default',
      skipTaskList: true,
      traceTaskContext: {
        source: 'issue',
        issueNumber: 131,
        branch: 'takt/131/add-trace-metadata',
        baseBranch: 'main',
        worktreePath: '/project/.takt/worktrees/131-add-trace-metadata',
      },
    } satisfies Parameters<typeof selectAndExecuteTask>[2] & {
      traceTaskContext: {
        source: 'issue';
        issueNumber: number;
        branch: string;
        baseBranch: string;
        worktreePath: string;
      };
    };

    await selectAndExecuteTask('/project', 'Add trace metadata from issue', options);

    const executeArg = mockExecuteTask.mock.calls[0]?.[0] as {
      traceTaskMetadata?: unknown;
    };
    expect(executeArg.traceTaskMetadata).toEqual({
      taskSummary: 'Add trace metadata from issue',
      taskSource: 'issue',
      issueNumber: 131,
      gitBranch: 'takt/131/add-trace-metadata',
      gitBaseBranch: 'main',
      worktreePath: '/project/.takt/worktrees/131-add-trace-metadata',
    });
  });

  it('skipTaskList: false の場合はタスクリストに追加する', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
      skipTaskList: false,
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockBuildBooleanTaskResult).toHaveBeenCalled();
    expect(mockPersistTaskResult).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList 未指定の場合はタスクリストに追加する', async () => {
    await selectAndExecuteTask('/project', 'test task', {
      workflow: 'default',
    });

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockPersistTaskResult).toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalled();
  });

  it('skipTaskList: true でエラー時は persistTaskError を呼ばない', async () => {
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        skipTaskList: true,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).not.toHaveBeenCalled();
    expect(mockPersistTaskError).not.toHaveBeenCalled();
  });

  it('attachments 付き skipTaskList: true では run context の order.md と添付を executeTask に渡す', async () => {
    const projectCwd = createTempProject();
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');
    mockExecuteTask.mockImplementationOnce(async (arg: {
      reportDirName: string;
    }) => {
      const runContextTaskDir = path.join(projectCwd, '.takt', 'runs', arg.reportDirName, 'context', 'task');
      expect(fs.readFileSync(path.join(runContextTaskDir, 'order.md'), 'utf-8')).toContain(
        `- [Image #1]: \`.takt/runs/${arg.reportDirName}/context/task/attachments/image-1.png\``,
      );
      expect(fs.readFileSync(path.join(runContextTaskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('png-data');
      return true;
    });

    await selectAndExecuteTask(projectCwd, 'Use [Image #1] as reference.', {
      workflow: 'default',
      skipTaskList: true,
      attachments: [{
        placeholder: '[Image #1]',
        tempPath,
        fileName: 'image-1.png',
      }],
    });

    expect(mockAddTask).not.toHaveBeenCalled();
    const executeArg = mockExecuteTask.mock.calls[0]?.[0] as {
      task: string;
      reportDirName: string;
    };
    expect(executeArg.task).toContain('Primary spec:');
    expect(executeArg.task).toContain('context/task/order.md');
    expect(executeArg.reportDirName).toBeDefined();

    const runContextTaskDir = path.join(projectCwd, '.takt', 'runs', executeArg.reportDirName, 'context', 'task');
    expect(fs.existsSync(runContextTaskDir)).toBe(true);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'tasks'))).toBe(false);
  });

  it('attachments 付き skipTaskList: false では task record が参照する task spec を残す', async () => {
    const projectCwd = createTempProject();
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');

    await selectAndExecuteTask(projectCwd, 'Use [Image #1] as reference.', {
      workflow: 'default',
      skipTaskList: false,
      attachments: [{
        placeholder: '[Image #1]',
        tempPath,
        fileName: 'image-1.png',
      }],
    });

    const executeArg = mockExecuteTask.mock.calls[0]?.[0] as {
      reportDirName: string;
    };
    const addTaskOptions = mockAddTask.mock.calls[0]?.[1] as {
      task_dir: string;
    };
    expect(addTaskOptions.task_dir).not.toBe(`.takt/tasks/${executeArg.reportDirName}`);

    const taskSpecDir = path.join(projectCwd, addTaskOptions.task_dir);
    const runContextTaskDir = path.join(projectCwd, '.takt', 'runs', executeArg.reportDirName, 'context', 'task');
    expect(fs.readFileSync(path.join(taskSpecDir, 'order.md'), 'utf-8')).toContain(
      '- [Image #1]: `attachments/image-1.png`',
    );
    expect(fs.readFileSync(path.join(taskSpecDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('png-data');
    expect(fs.readFileSync(path.join(runContextTaskDir, 'order.md'), 'utf-8')).toContain(
      `- [Image #1]: \`.takt/runs/${executeArg.reportDirName}/context/task/attachments/image-1.png\``,
    );
    expect(fs.readFileSync(path.join(runContextTaskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('png-data');
    expect(mockPersistTaskResult).toHaveBeenCalled();
  });

  it('attachments 付き skipTaskList: false の連続実行では run context を再利用しない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T01:02:03.000Z'));
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2);

    const projectCwd = createTempProject();
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');
    const task = 'Use [Image #1] as reference.';
    const options = {
      workflow: 'default',
      skipTaskList: false,
      attachments: [{
        placeholder: '[Image #1]',
        tempPath,
        fileName: 'image-1.png',
      }],
    };

    await selectAndExecuteTask(projectCwd, task, options);
    await selectAndExecuteTask(projectCwd, task, options);

    const firstExecuteArg = mockExecuteTask.mock.calls[0]?.[0] as { reportDirName: string };
    const secondExecuteArg = mockExecuteTask.mock.calls[1]?.[0] as { reportDirName: string };
    const firstTaskOptions = mockAddTask.mock.calls[0]?.[1] as { task_dir: string };
    const secondTaskOptions = mockAddTask.mock.calls[1]?.[1] as { task_dir: string };

    expect(firstExecuteArg.reportDirName).not.toBe(secondExecuteArg.reportDirName);
    expect(firstTaskOptions.task_dir).not.toBe(`.takt/tasks/${firstExecuteArg.reportDirName}`);
    expect(secondTaskOptions.task_dir).not.toBe(`.takt/tasks/${secondExecuteArg.reportDirName}`);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'runs', firstExecuteArg.reportDirName, 'context', 'task', 'order.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'runs', secondExecuteArg.reportDirName, 'context', 'task', 'order.md'))).toBe(true);
  });

  it('attachments 付き skipTaskList: true で executeTask が失敗しても prepared task spec を削除し、run context は残す', async () => {
    const projectCwd = createTempProject();
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask(projectCwd, 'Use [Image #1] as reference.', {
        workflow: 'default',
        skipTaskList: true,
        attachments: [{
          placeholder: '[Image #1]',
          tempPath,
          fileName: 'image-1.png',
        }],
      }),
    ).rejects.toThrow('Task execution failed');

    const executeArg = mockExecuteTask.mock.calls[0]?.[0] as { reportDirName: string };
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'runs', executeArg.reportDirName, 'context', 'task'))).toBe(true);
    expect(mockPersistTaskError).not.toHaveBeenCalled();
  });

  it('attachments 付き skipTaskList: true で taskSuccess が false でも prepared task spec を削除し、run context は残す', async () => {
    const projectCwd = createTempProject();
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');
    mockExecuteTask.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as never);

    try {
      await expect(
        selectAndExecuteTask(projectCwd, 'Use [Image #1] as reference.', {
          workflow: 'default',
          skipTaskList: true,
          attachments: [{
            placeholder: '[Image #1]',
            tempPath,
            fileName: 'image-1.png',
          }],
        }),
      ).rejects.toThrow('process.exit:1');
    } finally {
      exitSpy.mockRestore();
    }

    const executeArg = mockExecuteTask.mock.calls[0]?.[0] as { reportDirName: string };
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'runs', executeArg.reportDirName, 'context', 'task'))).toBe(true);
    expect(mockPersistTaskResult).not.toHaveBeenCalled();
  });

  it('attachments 付き skipTaskList: false で addTask が失敗した場合は prepared spec と staged spec を削除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T01:02:03.000Z'));

    const projectCwd = createTempProject();
    const task = 'Use [Image #1] as reference.';
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const taskSpecSlug = generateReportDir(task);
    const reportDirName = generateExecutionReportDir(projectCwd, task);
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');
    mockAddTask.mockImplementationOnce(() => {
      throw new Error('addTask failed');
    });

    await expect(
      selectAndExecuteTask(projectCwd, task, {
        workflow: 'default',
        skipTaskList: false,
        attachments: [{
          placeholder: '[Image #1]',
          tempPath,
          fileName: 'image-1.png',
        }],
      }),
    ).rejects.toThrow('addTask failed');

    expect(fs.existsSync(path.join(projectCwd, '.takt', 'tasks', taskSpecSlug))).toBe(false);
    expect(fs.existsSync(path.join(projectCwd, '.takt', 'runs', reportDirName))).toBe(false);
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('attachments の staging に失敗した場合は prepared task spec を削除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T01:02:03.000Z'));

    const projectCwd = createTempProject();
    const task = 'Use [Image #1] as reference.';
    const taskSpecSlug = generateReportDir(task);
    const blockedRunsPath = path.join(projectCwd, '.takt', 'runs');
    const tempAttachmentDir = path.join(projectCwd, 'tmp-attachments');
    const tempPath = path.join(tempAttachmentDir, 'image-1.png');
    fs.mkdirSync(path.dirname(blockedRunsPath), { recursive: true });
    fs.writeFileSync(blockedRunsPath, 'not-a-directory', 'utf-8');
    fs.mkdirSync(tempAttachmentDir, { recursive: true });
    fs.writeFileSync(tempPath, 'png-data', 'utf-8');

    await expect(
      selectAndExecuteTask(projectCwd, task, {
        workflow: 'default',
        skipTaskList: true,
        attachments: [{
          placeholder: '[Image #1]',
          tempPath,
          fileName: 'image-1.png',
        }],
      }),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(projectCwd, '.takt', 'tasks', taskSpecSlug))).toBe(false);
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('skipTaskList: false でエラー時は persistTaskError を呼ぶ', async () => {
    mockExecuteTask.mockRejectedValue(new Error('Task execution failed'));

    await expect(
      selectAndExecuteTask('/project', 'test task', {
        workflow: 'default',
        skipTaskList: false,
      }),
    ).rejects.toThrow('Task execution failed');

    expect(mockAddTask).toHaveBeenCalled();
    expect(mockPersistTaskError).toHaveBeenCalled();
  });
});
