import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskInfo } from '../infra/task/index.js';
import * as infraTask from '../infra/task/index.js';
import * as runOrderContent from '../core/workflow/run/order-content.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { unexpectedWorkflowKey } from '../../test/helpers/unknown-contract-test-keys.js';

const mockGetGitProvider = vi.hoisted(() => vi.fn());
let originalTaktConfigDir: string | undefined;

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: mockGetGitProvider,
}));

import { resolveTaskExecution, resolveTaskIssue } from '../features/tasks/execute/resolveTask.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
  if (originalTaktConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  vi.restoreAllMocks();
});

beforeEach(() => {
  originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

function createTempProjectDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-resolve-task-test-'));
  tempRoots.add(root);
  return root;
}

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  const baseData = { task: 'Run task', workflow: 'default' } as NonNullable<TaskInfo['data']>;
  const data = overrides.data === undefined
    ? baseData
    : overrides.data === null
      ? null
      : ({
          ...baseData,
          ...(overrides.data as Record<string, unknown>),
        } as NonNullable<TaskInfo['data']>);

  return {
    filePath: '/tasks/task.yaml',
    name: 'task-name',
    content: 'Run task',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    ...overrides,
    data,
  };
}

function configureIsolatedGlobalConfig(projectRoot: string, yaml = 'language: en\n'): void {
  const globalConfigDir = path.join(projectRoot, '.test-global-takt');
  fs.mkdirSync(globalConfigDir, { recursive: true });
  process.env.TAKT_CONFIG_DIR = globalConfigDir;
  fs.writeFileSync(path.join(globalConfigDir, 'config.yaml'), yaml, 'utf-8');
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

function writeTaktFile(baseDir: string, relativePath: string, content: string): string {
  const filePath = path.join(baseDir, '.takt', relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function readTaktFile(baseDir: string, relativePath: string): string {
  return fs.readFileSync(path.join(baseDir, '.takt', relativePath), 'utf-8');
}

const resolveTaskExecutionStrict = resolveTaskExecution as (task: TaskInfo, projectCwd: string) => ReturnType<typeof resolveTaskExecution>;

describe('resolveTaskExecution', () => {
  it('should throw when task data is null', async () => {
    const root = createTempProjectDir();
    const task = createTask({ data: null });

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow();
  });

  it('should throw when task data does not include workflow', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task without workflow',
        workflow: undefined,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow();
  });

  it('should return defaults for valid task data', async () => {
    const root = createTempProjectDir();
    const task = createTask();

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result).toMatchObject({
      execCwd: root,
      workflowIdentifier: 'default',
      isWorktree: false,
      autoPr: false,
      draftPr: false,
      shouldPublishBranchToOrigin: false,
    });
  });

  it('should resolve workflowIdentifier from workflow', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task',
        workflow: 'workflow-only',
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.workflowIdentifier).toBe('workflow-only');
  });

  it('should resolve startStep from start_movement', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task',
        start_movement: 'implement',
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('implement');
  });

  it('should prefer resume_point root step over stored start_movement on workflow_call retry', async () => {
    const root = createTempProjectDir();
    const workflowDir = path.join(root, '.takt', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: delegate',
      'max_steps: 5',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: takt/coding',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));

    const task = createTask({
      data: ({
        task: 'Run task',
        start_movement: 'review',
        resume_point: {
          version: 1,
          stack: [
            { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
            { workflow: 'takt/coding', step: 'review', kind: 'agent' },
          ],
          iteration: 7,
          elapsed_ms: 183245,
        },
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('delegate');
    expect(result.resumePoint).toEqual({
      ...task.data?.resume_point,
      stack: task.data?.resume_point?.stack.slice(0, 1),
    });
    expect(result.initialIterationOverride).toBe(7);
  });

  it('should preserve resume_point when child workflow step no longer resolves', async () => {
    const root = createTempProjectDir();
    const workflowDir = path.join(root, '.takt', 'workflows');
    fs.mkdirSync(path.join(workflowDir, 'takt'), { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: delegate',
      'max_steps: 5',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: takt/coding',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    fs.writeFileSync(path.join(workflowDir, 'takt', 'coding.yaml'), [
      'name: takt/coding',
      'subworkflow:',
      '  callable: true',
      'initial_step: fix',
      'max_steps: 5',
      'steps:',
      '  - name: fix',
      '    persona: fixer',
      '    instruction: Fix',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const task = createTask({
      data: ({
        task: 'Run task',
        resume_point: resumePoint,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('delegate');
    expect(result.resumePoint).toEqual({
      ...resumePoint,
      stack: resumePoint.stack.slice(0, 1),
    });
    expect(result.initialIterationOverride).toBe(7);
  });

  it('should preserve resume_point when child workflow no longer exists', async () => {
    const root = createTempProjectDir();
    const workflowDir = path.join(root, '.takt', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: delegate',
      'max_steps: 5',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: takt/coding',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));

    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const task = createTask({
      data: ({
        task: 'Run task',
        resume_point: resumePoint,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('delegate');
    expect(result.resumePoint).toEqual({
      ...resumePoint,
      stack: resumePoint.stack.slice(0, 1),
    });
    expect(result.initialIterationOverride).toBe(7);
  });

  it('should preserve child resume_point entries when worktree workflow exists only under execCwd', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'task-name');
    const worktreeRootWorkflowDir = path.join(worktreePath, '.takt', 'workflows');
    const worktreeWorkflowDir = path.join(worktreePath, '.takt', 'workflows', 'takt');
    writeTaktFile(root, 'config.yaml', 'sync_project_local_takt_on_retry: false\n');
    fs.mkdirSync(worktreeRootWorkflowDir, { recursive: true });
    fs.mkdirSync(worktreeWorkflowDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeRootWorkflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: delegate',
      'max_steps: 5',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: ./takt/coding.yaml',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    fs.writeFileSync(path.join(worktreeWorkflowDir, 'coding.yaml'), [
      'name: takt/coding',
      'subworkflow:',
      '  callable: true',
      'initial_step: review',
      'max_steps: 5',
      'steps:',
      '  - name: review',
      '    persona: reviewer',
      '    instruction: Review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const task = createTask({
      worktreePath,
      data: ({
        task: 'Run task',
        workflow: './.takt/workflows/default.yaml',
        worktree: true,
        resume_point: resumePoint,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.execCwd).toBe(worktreePath);
    expect(result.startStep).toBe('delegate');
    expect(result.resumePoint).toEqual(resumePoint);
    expect(result.initialIterationOverride).toBe(7);
  });

  it('should trim resume_point to the nearest valid workflow_call when a deep child step no longer resolves', async () => {
    const root = createTempProjectDir();
    const workflowDir = path.join(root, '.takt', 'workflows');
    fs.mkdirSync(path.join(workflowDir, 'takt'), { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: delegate',
      'max_steps: 5',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: takt/coding',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    fs.writeFileSync(path.join(workflowDir, 'takt', 'coding.yaml'), [
      'name: takt/coding',
      'subworkflow:',
      '  callable: true',
      'initial_step: delegate_review',
      'max_steps: 5',
      'steps:',
      '  - name: delegate_review',
      '    kind: workflow_call',
      '    call: takt/review-loop',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    fs.writeFileSync(path.join(workflowDir, 'takt', 'review-loop.yaml'), [
      'name: takt/review-loop',
      'subworkflow:',
      '  callable: true',
      'initial_step: fix',
      'max_steps: 5',
      'steps:',
      '  - name: fix',
      '    persona: fixer',
      '    instruction: Fix',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const resumePoint = {
      version: 1 as const,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' as const },
        { workflow: 'takt/coding', step: 'delegate_review', kind: 'workflow_call' as const },
        { workflow: 'takt/review-loop', step: 'review', kind: 'agent' as const },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const task = createTask({
      data: ({
        task: 'Run task',
        resume_point: resumePoint,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('delegate');
    expect(result.resumePoint).toEqual({
      ...resumePoint,
      stack: resumePoint.stack.slice(0, 2),
    });
    expect(result.initialIterationOverride).toBe(7);
  });

  it('should drop resume_point when its root step no longer resolves', async () => {
    const root = createTempProjectDir();
    const workflowDir = path.join(root, '.takt', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'default.yaml'), [
      'name: default',
      'initial_step: implement',
      'max_steps: 5',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: Implement',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    const task = createTask({
      data: ({
        task: 'Run task',
        start_step: 'implement',
        resume_point: {
          version: 1,
          stack: [
            { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
            { workflow: 'takt/coding', step: 'review', kind: 'agent' },
          ],
          iteration: 7,
          elapsed_ms: 183245,
        },
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.startStep).toBe('implement');
    expect(result.resumePoint).toBeUndefined();
    expect(result.initialIterationOverride).toBeUndefined();
  });

  it('should fail fast when an unknown workflow key is present', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task',
        workflow: 'workflow-a',
        [unexpectedWorkflowKey]: 'workflow-conflict',
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow(
      new RegExp(unexpectedWorkflowKey)
    );
  });

  it('should generate report context and copy issue-bearing task spec', async () => {
    const root = createTempProjectDir();
    const taskDir = '.takt/tasks/issue-task-123';
    const sourceTaskDir = path.join(root, taskDir);
    const sourceOrderPath = path.join(sourceTaskDir, 'order.md');
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(sourceOrderPath, '# task instruction');

    const task = createTask({
      taskDir,
      data: {
        task: 'Run issue task',
        issue: 12345,
        auto_pr: true,
      },
    });

    const result = await resolveTaskExecutionStrict(task, root);
    const expectedReportOrderPath = path.join(root, '.takt', 'runs', 'issue-task-123', 'context', 'task', 'order.md');

    expect(result).toMatchObject({
      execCwd: root,
      workflowIdentifier: 'default',
      isWorktree: false,
      autoPr: true,
      draftPr: false,
      orderContent: '# task instruction',
      shouldPublishBranchToOrigin: true,
      reportDirName: 'issue-task-123',
      issueNumber: 12345,
      taskPrompt: expect.stringContaining('Primary spec: `.takt/runs/issue-task-123/context/task/order.md`'),
    });
    expect(fs.existsSync(expectedReportOrderPath)).toBe(true);
    expect(fs.readFileSync(expectedReportOrderPath, 'utf-8')).toBe('# task instruction');
  });

  it('should stage order.md into the worktree run context and return order content', async () => {
    const root = createTempProjectDir();
    const worktreePath = createTempProjectDir();
    const taskDir = '.takt/tasks/worktree-task-123';
    const sourceTaskDir = path.join(root, taskDir);
    const sourceOrderPath = path.join(sourceTaskDir, 'order.md');
    const orderContent = '# worktree task instruction';
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(sourceOrderPath, orderContent);

    const task = createTask({
      slug: 'worktree-task-123',
      taskDir,
      data: ({
        task: 'Run worktree task',
        workflow: 'default',
        worktree: true,
        branch: 'feature/worktree-task-123',
        auto_pr: true,
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: worktreePath,
      branch: 'feature/worktree-task-123',
    });

    const result = await resolveTaskExecutionStrict(task, root);
    const stagedOrderPath = path.join(worktreePath, '.takt', 'runs', 'worktree-task-123', 'context', 'task', 'order.md');

    expect(result).toMatchObject({
      execCwd: worktreePath,
      workflowIdentifier: 'default',
      isWorktree: true,
      autoPr: true,
      draftPr: false,
      shouldPublishBranchToOrigin: true,
      reportDirName: 'worktree-task-123',
      branch: 'feature/worktree-task-123',
      worktreePath,
      orderContent,
      taskPrompt: expect.stringContaining('Primary spec: `.takt/runs/worktree-task-123/context/task/order.md`'),
    });
    expect(fs.readFileSync(stagedOrderPath, 'utf-8')).toBe(orderContent);

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should reject symlinked order.md before staging task context', async () => {
    const root = createTempProjectDir();
    const taskDir = '.takt/tasks/symlink-task-123';
    const sourceTaskDir = path.join(root, taskDir);
    const linkedOrderPath = path.join(root, 'shared-order.md');
    const orderContent = '# symlink task instruction';
    fs.mkdirSync(sourceTaskDir, { recursive: true });
    fs.writeFileSync(linkedOrderPath, orderContent);
    fs.symlinkSync(linkedOrderPath, path.join(sourceTaskDir, 'order.md'));

    const task = createTask({
      taskDir,
      data: ({
        task: 'Run symlink task',
        workflow: 'default',
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const stagedOrderPath = path.join(root, '.takt', 'runs', 'symlink-task-123', 'context', 'task', 'order.md');

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow(
      `Task spec file must be a regular file: ${path.join(sourceTaskDir, 'order.md')}`,
    );
    expect(fs.existsSync(stagedOrderPath)).toBe(false);
  });

  it('should not read run context order content when task_dir is absent', async () => {
    const root = createTempProjectDir();
    const readRunContextOrderContentSpy = vi.spyOn(runOrderContent, 'readRunContextOrderContent');
    const task = createTask({
      content: 'Run task without task_dir',
      data: ({
        task: 'Run task without task_dir',
        workflow: 'default',
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.orderContent).toBeUndefined();
    expect(readRunContextOrderContentSpy).not.toHaveBeenCalled();
    readRunContextOrderContentSpy.mockRestore();
  });

  it('should pass base_branch to shared clone options when worktree task has base_branch', async () => {
    const root = createTempProjectDir();
    const taskData = {
      task: 'Run task with base branch',
      worktree: true,
      branch: 'feature/base-branch',
      base_branch: 'release/main',
    };
    const task = createTask({
      data: ({
        ...taskData,
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'release/main',
      }),
      undefined,
    );
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should forward abortSignal to shared clone creation', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      slug: 'abortable-clone',
      data: ({
        task: 'Run abortable clone task',
        worktree: true,
        branch: 'feature/abortable-clone',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });
    const abortController = new AbortController();

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: '/tmp/shared-clone',
      branch: 'feature/abortable-clone',
    });

    await resolveTaskExecution(task, root, abortController.signal);

    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        worktree: true,
        branch: 'feature/abortable-clone',
        taskSlug: 'abortable-clone',
      }),
      abortController.signal,
    );

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should prefer base_branch over legacy baseBranch when both are present', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      slug: 'prefer-base-branch',
      data: ({
        task: 'Run task with both base branch fields',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);
    const cloneOptions = mockCreateSharedClone.mock.calls[0]?.[1] as Record<string, unknown> | undefined;

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(cloneOptions).toBeDefined();
    expect(cloneOptions).toMatchObject({
      worktree: true,
      branch: 'feature/base-branch',
      taskSlug: 'prefer-base-branch',
      baseBranch: 'release/main',
    });
    expect(cloneOptions).not.toMatchObject({ baseBranch: 'legacy/main' });
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should ignore legacy baseBranch field when base_branch is not set', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      slug: 'legacy-base-branch',
      data: ({
        task: 'Run task with legacy baseBranch',
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: undefined,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'develop',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: '/tmp/shared-clone',
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);
    const cloneOptions = mockCreateSharedClone.mock.calls[0]?.[1] as Record<string, unknown> | undefined;

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, undefined);
    expect(cloneOptions).toBeDefined();
    expect(cloneOptions).toMatchObject({
      worktree: true,
      branch: 'feature/base-branch',
      taskSlug: 'legacy-base-branch',
    });
    expect(cloneOptions).not.toHaveProperty('baseBranch');
    expect(result.baseBranch).toBe('develop');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should preserve base_branch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with base branch',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('release/main');
    expect(mockCreateSharedClone).not.toHaveBeenCalled();

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should prefer base_branch over legacy baseBranch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with both base branch fields',
        worktree: true,
        branch: 'feature/base-branch',
        base_branch: 'release/main',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'release/main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, 'release/main');
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('release/main');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should ignore legacy baseBranch when reusing an existing worktree path', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with legacy base branch',
        worktree: true,
        branch: 'feature/base-branch',
        baseBranch: 'legacy/main',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'develop',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: worktreePath,
      branch: 'feature/base-branch',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockResolveBaseBranch).toHaveBeenCalledWith(root, undefined);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(result.baseBranch).toBe('develop');

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should not reuse existing worktree path outside clone base directory', async () => {
    const root = createTempProjectDir();
    const outsidePath = path.join(os.tmpdir(), `takt-outside-${Date.now()}`);
    fs.mkdirSync(outsidePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with untrusted worktree path',
        worktree: true,
        branch: 'feature/outside-worktree',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: outsidePath,
      status: 'pending',
    });

    const safeClonePath = path.join(root, '.takt', 'worktrees', 'safe-clone');
    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: safeClonePath,
      branch: 'feature/outside-worktree',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockCreateSharedClone).toHaveBeenCalled();
    expect(result.execCwd).toBe(safeClonePath);
    expect(result.worktreePath).toBe(safeClonePath);
    expect(result.isWorktree).toBe(true);

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
    fs.rmSync(outsidePath, { recursive: true, force: true });
  });

  it('should not reuse a symlinked worktree path that resolves outside clone base directory', async () => {
    const root = createTempProjectDir();
    const outsidePath = createTempProjectDir();
    const worktreeLinkPath = path.join(root, '.takt', 'worktrees', 'linked-worktree');
    fs.mkdirSync(path.dirname(worktreeLinkPath), { recursive: true });
    fs.symlinkSync(outsidePath, worktreeLinkPath, 'dir');

    const task = createTask({
      data: ({
        task: 'Run task with symlinked worktree path',
        worktree: true,
        branch: 'feature/symlink-worktree',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath: worktreeLinkPath,
      status: 'pending',
    });

    const safeClonePath = path.join(root, '.takt', 'worktrees', 'safe-clone');
    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: safeClonePath,
      branch: 'feature/symlink-worktree',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockCreateSharedClone).toHaveBeenCalled();
    expect(result.execCwd).toBe(safeClonePath);
    expect(result.worktreePath).toBe(safeClonePath);
    expect(result.isWorktree).toBe(true);

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should reuse existing worktree path within clone base directory', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    const task = createTask({
      data: ({
        task: 'Run task with safe worktree path',
        worktree: true,
        branch: 'feature/safe-worktree',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    const mockResolveBaseBranch = vi.spyOn(infraTask, 'resolveBaseBranch').mockReturnValue({
      branch: 'main',
    });
    const mockCreateSharedClone = vi.spyOn(infraTask, 'createSharedCloneAbortable').mockResolvedValue({
      path: worktreePath,
      branch: 'feature/safe-worktree',
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(result.execCwd).toBe(worktreePath);
    expect(result.worktreePath).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);

    mockCreateSharedClone.mockRestore();
    mockResolveBaseBranch.mockRestore();
  });

  it('should sync project-local .takt resources into a reused worktree by default', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    writeTaktFile(root, 'workflows/default.yaml', 'name: root-default\n');
    writeTaktFile(root, 'facets/output-contracts/summary.md', '# root summary\n');
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');
    writeTaktFile(worktreePath, 'workflows/default.yaml', 'name: stale-default\n');
    writeTaktFile(worktreePath, 'facets/output-contracts/summary.md', '# stale summary\n');
    writeTaktFile(worktreePath, 'runs/keep/log.md', 'keep runtime log\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with synced worktree',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.execCwd).toBe(worktreePath);
    expect(result.worktreePath).toBe(worktreePath);
    expect(result.isWorktree).toBe(true);
    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: ja\n');
    expect(readTaktFile(worktreePath, 'workflows/default.yaml')).toBe('name: root-default\n');
    expect(readTaktFile(worktreePath, 'facets/output-contracts/summary.md')).toBe('# root summary\n');
    expect(readTaktFile(worktreePath, 'runs/keep/log.md')).toBe('keep runtime log\n');

    branchExistsSpy.mockRestore();
  });

  it('should remove deleted project-local .takt resources from a reused worktree without deleting runtime data', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    writeTaktFile(root, 'facets/personas/coder.md', 'You are root coder.\n');
    writeTaktFile(worktreePath, 'workflows/stale.yaml', 'name: stale\n');
    writeTaktFile(worktreePath, 'facets/personas/legacy.md', 'legacy persona\n');
    writeTaktFile(worktreePath, 'runs/existing/log.md', 'keep run history\n');
    writeTaktFile(worktreePath, 'tasks/existing.yaml', 'keep queued task\n');
    writeTaktFile(worktreePath, 'worktree-sessions/existing.json', '{"session":"keep"}\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with synced worktree',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
    });

    await resolveTaskExecutionStrict(task, root);

    expect(fs.existsSync(path.join(worktreePath, '.takt', 'workflows', 'stale.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.takt', 'facets', 'personas', 'legacy.md'))).toBe(false);
    expect(readTaktFile(worktreePath, 'facets/personas/coder.md')).toBe('You are root coder.\n');
    expect(readTaktFile(worktreePath, 'runs/existing/log.md')).toBe('keep run history\n');
    expect(readTaktFile(worktreePath, 'tasks/existing.yaml')).toBe('keep queued task\n');
    expect(readTaktFile(worktreePath, 'worktree-sessions/existing.json')).toBe('{"session":"keep"}\n');

    branchExistsSpy.mockRestore();
  });

  it('should remove synced .takt resources from a reused worktree when the project-local .takt has no syncable resources', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');
    writeTaktFile(worktreePath, 'workflows/stale.yaml', 'name: stale\n');
    writeTaktFile(worktreePath, 'facets/personas/legacy.md', 'legacy persona\n');
    writeTaktFile(worktreePath, 'runs/existing/log.md', 'keep run history\n');
    writeTaktFile(worktreePath, 'tasks/existing.yaml', 'keep queued task\n');
    writeTaktFile(worktreePath, 'worktree-sessions/existing.json', '{"session":"keep"}\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with synced worktree',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
    });

    await resolveTaskExecutionStrict(task, root);

    expect(fs.existsSync(path.join(worktreePath, '.takt', 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.takt', 'workflows', 'stale.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.takt', 'facets', 'personas', 'legacy.md'))).toBe(false);
    expect(readTaktFile(worktreePath, 'runs/existing/log.md')).toBe('keep run history\n');
    expect(readTaktFile(worktreePath, 'tasks/existing.yaml')).toBe('keep queued task\n');
    expect(readTaktFile(worktreePath, 'worktree-sessions/existing.json')).toBe('{"session":"keep"}\n');

    branchExistsSpy.mockRestore();
  });

  it('should sync project-local .takt resources for a reused worktree re-execution started from start_step', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    writeTaktFile(root, 'workflows/default.yaml', 'name: root-default\n');
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');
    writeTaktFile(worktreePath, 'workflows/default.yaml', 'name: stale-default\n');
    writeTaktFile(worktreePath, 'runs/existing/log.md', 'keep run history\n');
    writeTaktFile(worktreePath, 'tasks/existing.yaml', 'keep queued task\n');
    writeTaktFile(worktreePath, 'worktree-sessions/existing.json', '{"session":"keep"}\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with start_step retry',
        worktree: true,
        branch: 'feature/retry-sync',
        start_step: 'implement',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: ja\n');
    expect(readTaktFile(worktreePath, 'workflows/default.yaml')).toBe('name: root-default\n');
    expect(readTaktFile(worktreePath, 'runs/existing/log.md')).toBe('keep run history\n');
    expect(readTaktFile(worktreePath, 'tasks/existing.yaml')).toBe('keep queued task\n');
    expect(readTaktFile(worktreePath, 'worktree-sessions/existing.json')).toBe('{"session":"keep"}\n');

    branchExistsSpy.mockRestore();
  });

  it('should sync project-local .takt resources for a reused worktree re-execution resumed from resume_point', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    writeTaktFile(root, 'facets/personas/coder.md', 'You are root coder.\n');
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');
    writeTaktFile(worktreePath, 'facets/personas/coder.md', 'You are stale coder.\n');
    writeTaktFile(worktreePath, 'runs/existing/log.md', 'keep run history\n');
    writeTaktFile(worktreePath, 'tasks/existing.yaml', 'keep queued task\n');
    writeTaktFile(worktreePath, 'worktree-sessions/existing.json', '{"session":"keep"}\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with resume_point retry',
        worktree: true,
        branch: 'feature/retry-sync',
        resume_point: {
          version: 1,
          stack: [
            { workflow: 'default', step: 'fix', kind: 'agent' },
          ],
          iteration: 3,
          elapsed_ms: 1200,
        },
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: ja\n');
    expect(readTaktFile(worktreePath, 'facets/personas/coder.md')).toBe('You are root coder.\n');
    expect(readTaktFile(worktreePath, 'runs/existing/log.md')).toBe('keep run history\n');
    expect(readTaktFile(worktreePath, 'tasks/existing.yaml')).toBe('keep queued task\n');
    expect(readTaktFile(worktreePath, 'worktree-sessions/existing.json')).toBe('{"session":"keep"}\n');

    branchExistsSpy.mockRestore();
  });

  it('should fail fast when syncing project-local .takt into a reused worktree fails', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const outsideRoot = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    const outsideWorkflowsDir = path.join(outsideRoot, 'outside-workflows');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    fs.mkdirSync(outsideWorkflowsDir, { recursive: true });
    fs.writeFileSync(path.join(outsideWorkflowsDir, 'outside.yaml'), 'outside workflow\n', 'utf-8');
    fs.symlinkSync(outsideWorkflowsDir, path.join(root, '.takt', 'workflows'));
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');

    vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with sync failure',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow('Refusing to sync symbolic link');
  });

  it('should fail fast when a project-local .takt sync source is a dangling symlink', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    const missingConfigTarget = path.join(root, 'missing-config.yaml');
    fs.mkdirSync(worktreePath, { recursive: true });

    fs.mkdirSync(path.join(root, '.takt'), { recursive: true });
    fs.symlinkSync(missingConfigTarget, path.join(root, '.takt', 'config.yaml'));
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with dangling source symlink',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await expect(resolveTaskExecutionStrict(task, root)).rejects.toThrow('Refusing to sync symbolic link');
    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: en\n');

    branchExistsSpy.mockRestore();
  });

  it('should replace a symlinked config.yaml in a reused worktree without touching the linked file', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const outsideRoot = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    const outsideConfigPath = path.join(outsideRoot, 'outside-config.yaml');
    fs.mkdirSync(path.join(worktreePath, '.takt'), { recursive: true });
    fs.writeFileSync(outsideConfigPath, 'outside config\n', 'utf-8');

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    fs.symlinkSync(outsideConfigPath, path.join(worktreePath, '.takt', 'config.yaml'));

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with symlinked config',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(fs.readFileSync(outsideConfigPath, 'utf-8')).toBe('outside config\n');
    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: ja\n');
    expect(fs.lstatSync(path.join(worktreePath, '.takt', 'config.yaml')).isSymbolicLink()).toBe(false);

    branchExistsSpy.mockRestore();
  });

  it('should replace a symlinked workflows directory in a reused worktree without touching the linked directory', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const outsideRoot = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    const outsideWorkflowsDir = path.join(outsideRoot, 'outside-workflows');
    fs.mkdirSync(path.join(worktreePath, '.takt'), { recursive: true });
    fs.mkdirSync(outsideWorkflowsDir, { recursive: true });
    fs.writeFileSync(path.join(outsideWorkflowsDir, 'outside.yaml'), 'outside workflow\n', 'utf-8');

    writeTaktFile(root, 'workflows/default.yaml', 'name: root-default\n');
    fs.symlinkSync(outsideWorkflowsDir, path.join(worktreePath, '.takt', 'workflows'));

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with symlinked workflows',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(fs.readFileSync(path.join(outsideWorkflowsDir, 'outside.yaml'), 'utf-8')).toBe('outside workflow\n');
    expect(readTaktFile(worktreePath, 'workflows/default.yaml')).toBe('name: root-default\n');
    expect(fs.lstatSync(path.join(worktreePath, '.takt', 'workflows')).isSymbolicLink()).toBe(false);

    branchExistsSpy.mockRestore();
  });

  it('should replace a symlinked .takt directory in a reused worktree without touching the linked directory', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const outsideRoot = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    const outsideTaktDir = path.join(outsideRoot, 'outside-takt');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(outsideTaktDir, { recursive: true });
    fs.writeFileSync(path.join(outsideTaktDir, 'outside.txt'), 'outside takt\n', 'utf-8');

    writeTaktFile(root, 'config.yaml', 'language: ja\n');
    fs.symlinkSync(outsideTaktDir, path.join(worktreePath, '.takt'));

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with symlinked takt dir',
        worktree: true,
        branch: 'feature/retry-sync',
        retry_note: 'retry with latest takt',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'pending',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(fs.readFileSync(path.join(outsideTaktDir, 'outside.txt'), 'utf-8')).toBe('outside takt\n');
    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: ja\n');
    expect(fs.lstatSync(path.join(worktreePath, '.takt')).isSymbolicLink()).toBe(false);

    branchExistsSpy.mockRestore();
  });

  it('should skip syncing a reused worktree when sync_project_local_takt_on_retry is disabled in project config', async () => {
    const root = createTempProjectDir();
    configureIsolatedGlobalConfig(root);
    const worktreePath = path.join(root, '.takt', 'worktrees', 'existing-safe-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });

    writeTaktFile(root, 'config.yaml', ['language: ja', 'sync_project_local_takt_on_retry: false'].join('\n'));
    writeTaktFile(root, 'workflows/default.yaml', 'name: root-default\n');
    writeTaktFile(worktreePath, 'config.yaml', 'language: en\n');
    writeTaktFile(worktreePath, 'workflows/default.yaml', 'name: stale-default\n');

    const branchExistsSpy = vi.spyOn(infraTask, 'branchExists').mockReturnValue(true);
    const task = createTask({
      data: ({
        task: 'Run task with synced worktree',
        worktree: true,
        branch: 'feature/retry-sync',
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
      status: 'failed',
    });

    await resolveTaskExecutionStrict(task, root);

    expect(readTaktFile(worktreePath, 'config.yaml')).toBe('language: en\n');
    expect(readTaktFile(worktreePath, 'workflows/default.yaml')).toBe('name: stale-default\n');

    branchExistsSpy.mockRestore();
  });

  it('draft_pr: true が draftPr: true として解決される', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run draft task',
        auto_pr: true,
        draft_pr: true,
      },
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.draftPr).toBe(true);
    expect(result.autoPr).toBe(true);
    expect(result.shouldPublishBranchToOrigin).toBe(true);
  });

  it('managed_pr: true が managedPr: true として解決される', async () => {
    const root = createTempProjectDir();
    const worktreePath = path.join(root, '.takt', 'worktrees', 'managed-pr-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    const task = createTask({
      data: ({
        task: 'Run managed PR task',
        worktree: true,
        branch: 'feature/managed-pr',
        auto_pr: true,
        managed_pr: true,
      } as unknown) as NonNullable<TaskInfo['data']>,
      worktreePath,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result).toMatchObject({
      managedPr: true,
      autoPr: true,
    });
  });

  it('should_publish_branch_to_origin: true が shouldPublishBranchToOrigin: true として解決される', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run publish task',
        should_publish_branch_to_origin: true,
      },
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.shouldPublishBranchToOrigin).toBe(true);
  });

  it('auto_pr: true のみでも shouldPublishBranchToOrigin: true として解決される', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: {
        task: 'Run auto PR task',
        auto_pr: true,
      },
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.autoPr).toBe(true);
    expect(result.shouldPublishBranchToOrigin).toBe(true);
  });

  it('auto_pr: true のとき should_publish_branch_to_origin: false でも shouldPublishBranchToOrigin は true（OR 解決・#557）', async () => {
    const root = createTempProjectDir();
    const task = createTask({
      data: ({
        task: 'Run task',
        workflow: 'default',
        auto_pr: true,
        should_publish_branch_to_origin: false,
      } as unknown) as NonNullable<TaskInfo['data']>,
    });

    const result = await resolveTaskExecutionStrict(task, root);

    expect(result.autoPr).toBe(true);
    expect(result.shouldPublishBranchToOrigin).toBe(true);
  });
});

describe('resolveTaskIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issueNumber が undefined の場合は undefined を返す', () => {
    const result = resolveTaskIssue(undefined, '/tmp/test');

    expect(result).toBeUndefined();
  });

  it('CLI が利用不可の場合は undefined を返し、projectCwd を checkCliStatus に渡す', () => {
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: false, error: 'not installed' }),
      fetchIssue: vi.fn(),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    const result = resolveTaskIssue(42, '/my/project');

    expect(result).toBeUndefined();
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('fetchIssue が成功した場合は issue 配列を返す', () => {
    const issue = { number: 42, title: 'Test', body: 'Body', labels: [], comments: [] };
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: true }),
      fetchIssue: vi.fn().mockReturnValue(issue),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    const result = resolveTaskIssue(42, '/my/project');

    expect(result).toEqual([issue]);
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).toHaveBeenCalledWith(42, '/my/project');
  });

  it('fetchIssue が例外を投げた場合は undefined を返す', () => {
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: true }),
      fetchIssue: vi.fn().mockImplementation(() => { throw new Error('API error'); }),
    };
    mockGetGitProvider.mockReturnValue(mockProvider);

    const result = resolveTaskIssue(42, '/my/project');

    expect(result).toBeUndefined();
    expect(mockProvider.checkCliStatus).toHaveBeenCalledWith('/my/project');
    expect(mockProvider.fetchIssue).toHaveBeenCalledWith(42, '/my/project');
  });
});
