import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  mockFindRunForTask,
  mockReadRunMetaBySlug,
  mockResolveTaskWorkflowValue,
  mockLoadWorkflowByIdentifier,
  mockResolveWorkflowCallTarget,
  mockResolveTaskOrderContent,
  mockAssertReusableWorktreePath,
  mockAssertPrMergeRetryWorktreePath,
} = vi.hoisted(() => ({
  mockFindRunForTask: vi.fn((_cwd: string, _taskContent: string): string | null => null),
  mockReadRunMetaBySlug: vi.fn((_cwd: string, _slug: string, _onWarning?: (message: string) => void) => null),
  mockResolveTaskWorkflowValue: vi.fn((data?: Record<string, unknown>) => (
    typeof data?.workflow === 'string' ? data.workflow : undefined
  )),
  mockLoadWorkflowByIdentifier: vi.fn((_identifier: string, _projectDir: string, _options?: { lookupCwd?: string }): WorkflowConfig | null => null),
  mockResolveWorkflowCallTarget: vi.fn(),
  mockResolveTaskOrderContent: vi.fn((_projectDir: string, _taskDir: string | undefined, _content: string) => 'Canonical order'),
  mockAssertReusableWorktreePath: vi.fn((_projectDir: string, _worktreePath: string) => undefined),
  mockAssertPrMergeRetryWorktreePath: vi.fn((_projectDir: string, _worktreePath: string,
    _prepared: boolean) => false),
}));

vi.mock('../infra/task/index.js', () => ({
  resolveTaskWorkflowValue: (data?: Record<string, unknown>) => mockResolveTaskWorkflowValue(data),
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: (identifier: string, projectDir: string, options?: { lookupCwd?: string }) =>
    mockLoadWorkflowByIdentifier(identifier, projectDir, options),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

vi.mock('../core/workflow/run/run-meta.js', () => ({
  readRunMetaBySlug: (cwd: string, slug: string, onWarning?: (message: string) => void) =>
    mockReadRunMetaBySlug(cwd, slug, onWarning),
}));

vi.mock('../shared/ui/index.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../shared/utils/text.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sanitizeTerminalText: (value: string) => value,
}));

vi.mock('../features/tasks/orderRevision.js', () => ({
  resolveTaskOrderContent: (projectDir: string, taskDir: string | undefined, content: string) =>
    mockResolveTaskOrderContent(projectDir, taskDir, content),
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertPrMergeRetryWorktreePath: (projectDir: string, worktreePath: string, prepared: boolean) =>
    mockAssertPrMergeRetryWorktreePath(projectDir, worktreePath, prepared),
  toReusedTaskInfo: (task: unknown) => task,
  resolveReusedWorktreeExecution: (projectDir: string, task: { worktreePath: string }) => {
    mockAssertReusableWorktreePath(projectDir, task.worktreePath);
    return { worktreePath: task.worktreePath, execCwd: task.worktreePath, isWorktree: true };
  },
}));

vi.mock('../features/interactive/runSessionReader.js', () => ({
  findRunForTask: (cwd: string, taskContent: string) => mockFindRunForTask(cwd, taskContent),
}));

vi.mock('../features/tasks/list/requeueHelpers.js', () => ({
  resolveSelectedWorkflowOverride: (previousWorkflow: string | undefined, selectedWorkflow: string) => (
    previousWorkflow === selectedWorkflow ? undefined : selectedWorkflow
  ),
}));

import {
  buildFailedTaskRetryStartContext,
  prepareFailedTaskRetry,
  resolveFailedTaskRetryStart,
} from '../features/tasks/taskRetryPreparation.js';

const workflow: WorkflowConfig = {
  name: 'default',
  description: 'Default workflow',
  initialStep: 'plan',
  maxSteps: 10,
  steps: [
    { name: 'plan', persona: 'planner', personaDisplayName: 'planner', instruction: '' },
    { name: 'implement', persona: 'coder', personaDisplayName: 'coder', instruction: '' },
  ],
};

const failedTask: TaskListItem = {
  kind: 'failed',
  name: 'task-a',
  createdAt: '2026-09-28T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'task text',
  taskDir: '.takt/tasks/task-a',
  runSlug: 'run-a',
  worktreePath: '/project/.worktrees/task-a',
  failure: { step: 'implement', error: 'build failed' },
  data: { task: 'task text', workflow: 'default' },
};

describe('prepareFailedTaskRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWorkflowByIdentifier.mockReturnValue(workflow);
  });

  it('loads shared failed-task context from its worktree, run, and canonical order', () => {
    const preparation = prepareFailedTaskRetry(failedTask, '/project');

    expect(preparation).toMatchObject({
      worktreePath: '/project/.worktrees/task-a',
      failure: { step: 'implement', error: 'build failed' },
      failedStep: 'implement',
      matchedRunSlug: 'run-a',
      previousWorkflow: 'default',
      previousOrderContent: 'Canonical order',
    });
    expect(mockAssertReusableWorktreePath).toHaveBeenCalledWith(
      '/project',
      '/project/.worktrees/task-a',
    );
    expect(mockResolveTaskOrderContent).toHaveBeenCalledWith(
      '/project',
      '.takt/tasks/task-a',
      'task text',
    );
    expect(mockReadRunMetaBySlug).toHaveBeenCalledWith('/project/.worktrees/task-a', 'run-a', expect.any(Function));
    expect(mockFindRunForTask).not.toHaveBeenCalled();
  });

  it('prepares a clone failure without execution history from the project and canonical order', () => {
    const task: TaskListItem = {
      ...failedTask, worktreePath: undefined, runSlug: undefined, sourceRunSlug: undefined,
      failure: { error: 'Git clone failed' }, data: { task: failedTask.content, worktree: true, workflow: 'default' },
    };

    const preparation = prepareFailedTaskRetry(task, '/project');

    expect(preparation).toMatchObject({
      freshStart: true, worktreePath: undefined, interactionCwd: '/project', runsBaseDir: '/project',
      matchedRunSlug: null, previousOrderContent: 'Canonical order',
    });
    expect(mockFindRunForTask).not.toHaveBeenCalled();
    expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
  });

  it('prefers the saved initial start step when a clone fails before execution', () => {
    const task: TaskListItem = {
      ...failedTask, worktreePath: undefined, runSlug: undefined,
      failure: { error: 'Git clone failed' },
      data: { task: failedTask.content, worktree: true, workflow: 'default', start_step: 'implement' },
    };
    const preparation = prepareFailedTaskRetry(task, '/project');
    const context = buildFailedTaskRetryStartContext(preparation, '/project', 'default');

    expect(preparation.failedStep).toBeUndefined();
    expect(preparation.previousStartStep).toBe('implement');
    expect(context.options.preferredRootStep).toBe('implement');
    expect(resolveFailedTaskRetryStart(context, context.startOptions.defaultId).restartPoint?.stack[0]?.step)
      .toBe('implement');
  });

  it.each([
    { runSlug: 'earlier-run' },
    { runSlug: '' },
    { sourceRunSlug: 'earlier-run' },
    { failure: { step: 'plan', error: 'plan failed' } },
    { data: { task: 'task text', worktree: true, merge_task: true } },
  ])('refuses a missing worktree when retry history or merge ownership exists: %j', (change) => {
    const task: TaskListItem = {
      ...failedTask, worktreePath: undefined, runSlug: undefined,
      failure: { error: 'Git clone failed' },
      data: { task: failedTask.content, worktree: true, workflow: 'default' },
      ...change,
    };
    expect(() => prepareFailedTaskRetry(task, '/project')).toThrow('Worktree path is not set');
  });

  it('does not treat an empty saved worktree path as an uncreated clone', () => {
    mockAssertReusableWorktreePath.mockImplementationOnce(() => {
      throw new Error('Worktree path is invalid');
    });
    const task: TaskListItem = {
      ...failedTask, worktreePath: '', runSlug: undefined,
      failure: { error: 'Git clone failed' },
      data: { task: failedTask.content, worktree: true, workflow: 'default' },
    };
    expect(() => prepareFailedTaskRetry(task, '/project')).toThrow('Worktree path is invalid');
    expect(mockAssertReusableWorktreePath).toHaveBeenCalledWith('/project', '');
  });

  it('未準備のmerge cloneでは会話をproject rootで行いrun履歴もrootから読む', () => {
    const task: TaskListItem = { ...failedTask, data: { ...failedTask.data, task: failedTask.content, merge_task: true,
      merge_clone_prepared: false } };
    const preparation = prepareFailedTaskRetry(task, '/project');
    expect(preparation).toMatchObject({ worktreePath: failedTask.worktreePath,
      interactionCwd: '/project', runsBaseDir: '/project' });
    expect(mockReadRunMetaBySlug).toHaveBeenCalledWith('/project', 'run-a', expect.any(Function));
    buildFailedTaskRetryStartContext(preparation, '/project', 'default');
    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('default', '/project', { lookupCwd: '/project' });
  });

  it('merge taskにrunSlugがなければ同文の別taskのrun履歴を拾わない', () => {
    mockFindRunForTask.mockReturnValue('unrelated-run');
    const task: TaskListItem = { ...failedTask, runSlug: undefined,
      data: { ...failedTask.data, task: failedTask.content, merge_task: true, merge_clone_prepared: true } };

    const preparation = prepareFailedTaskRetry(task, '/project');

    expect(preparation.matchedRunSlug).toBeNull();
    expect(preparation.runMeta).toBeNull();
    expect(mockFindRunForTask).not.toHaveBeenCalled();
    expect(mockReadRunMetaBySlug).not.toHaveBeenCalled();
  });

  it('通常taskにrunSlugがなければcontentからrun履歴を探す', () => {
    mockFindRunForTask.mockReturnValue('matched-run');
    const task: TaskListItem = { ...failedTask, runSlug: undefined };

    const preparation = prepareFailedTaskRetry(task, '/project');

    expect(preparation.matchedRunSlug).toBe('matched-run');
    expect(mockFindRunForTask).toHaveBeenCalledWith(failedTask.worktreePath, failedTask.content);
  });

  it('uses the previous workflow and resolves the selected existing start option', () => {
    const preparation = prepareFailedTaskRetry(failedTask, '/project');
    const context = buildFailedTaskRetryStartContext(preparation, '/project', 'default');

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      'default',
      '/project',
      { lookupCwd: '/project/.worktrees/task-a' },
    );
    expect(context.workflowOverride).toBeUndefined();
    expect(context.startOptions.options.length).toBeGreaterThan(0);
    const resolved = resolveFailedTaskRetryStart(context, context.startOptions.defaultId);
    expect(resolved.label).toContain('implement');
    expect(resolved.restartPoint?.stack[0]?.step).toBe('implement');
  });

  it('rejects an unknown generated start option instead of using the default', () => {
    const preparation = prepareFailedTaskRetry(failedTask, '/project');
    mockLoadWorkflowByIdentifier.mockReturnValue({ ...workflow, name: 'other-workflow' });
    const context = buildFailedTaskRetryStartContext(preparation, '/project', 'other-workflow');

    expect(context.workflowOverride).toBe('other-workflow');
    expect(() => resolveFailedTaskRetryStart(context, 'model-invented-option'))
      .toThrow('Unknown task retry start selection: model-invented-option');
  });

  it('selects a leaf under the failed root call after its ref changes and a child step is removed', () => {
    const child: WorkflowConfig = {
      name: 'child', initialStep: 'child-leaf', maxSteps: 5, subworkflow: { callable: true },
      steps: [{ name: 'child-leaf', persona: 'coder', personaDisplayName: 'coder', instruction: '' }],
    };
    const root: WorkflowConfig = {
      name: 'default', initialStep: 'root-first', maxSteps: 5,
      steps: [
        { name: 'root-first', persona: 'planner', personaDisplayName: 'planner', instruction: '' },
        { name: 'delegate', kind: 'workflow_call', call: 'child', personaDisplayName: 'delegate', instruction: '' },
      ],
    };
    mockLoadWorkflowByIdentifier.mockReturnValue(root);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const resumePoint = {
      version: 2 as const,
      stack: [
        { workflow: 'default', workflow_ref: 'saved-parent-ref', step: 'delegate', kind: 'workflow_call' as const, occurrence: 1, call_instance: 1 },
        { workflow: 'child', workflow_ref: 'saved-child-ref', step: 'removed-leaf', kind: 'agent' as const, occurrence: 1 },
      ],
      iteration: 2,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    const task: TaskListItem = {
      ...failedTask,
      failure: { step: 'removed-leaf', error: 'child failed' },
      data: { task: failedTask.content, workflow: 'default', resume_point: resumePoint },
    };

    const preparation = prepareFailedTaskRetry(task, '/project');
    const context = buildFailedTaskRetryStartContext(preparation, '/project', 'default');
    const resolved = resolveFailedTaskRetryStart(context, context.startOptions.defaultId);

    expect(context.options.preferredRootStep).toBe('delegate');
    expect(resolved.restartPoint?.stack.map((entry) => entry.step)).toEqual(['delegate', 'child-leaf']);
    expect(resolved.sourceResumePoint).toEqual(resumePoint);
  });

  it('carries restart evidence into a second CLI retry without presenting the old source as Resume', () => {
    const sourceResumePoint = {
      version: 2 as const,
      stack: [{
        workflow: 'default', workflow_ref: 'saved-root-ref', step: 'plan', kind: 'agent' as const, occurrence: 1,
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    const task: TaskListItem = {
      ...failedTask,
      data: { task: failedTask.content, workflow: 'default', source_resume_point: sourceResumePoint },
    };

    const preparation = prepareFailedTaskRetry(task, '/project');
    const context = buildFailedTaskRetryStartContext(preparation, '/project', 'default');
    const resolved = resolveFailedTaskRetryStart(context, context.startOptions.defaultId);

    expect(preparation.resumePoint).toBeUndefined();
    expect(context.options.resumePoint).toBeUndefined();
    expect(context.startOptions.options.some((option) => option.id === 'resume-checkpoint')).toBe(false);
    expect(resolved.restartPoint).toBeDefined();
    expect(resolved.sourceResumePoint).toEqual(sourceResumePoint);
  });

  it('rejects a non-failed task before touching its worktree', () => {
    const task: TaskListItem = { ...failedTask, kind: 'exceeded' };

    expect(() => prepareFailedTaskRetry(task, '/project'))
      .toThrow('Failed task retry action requires failed task. received: exceeded');
    expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
  });
});
