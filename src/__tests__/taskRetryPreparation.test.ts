import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  mockFindRunForTask,
  mockReadRunMetaBySlug,
  mockResolveTaskWorkflowValue,
  mockLoadWorkflowByIdentifier,
  mockResolveTaskOrderContent,
  mockAssertReusableWorktreePath,
} = vi.hoisted(() => ({
  mockFindRunForTask: vi.fn((_cwd: string, _taskContent: string) => null),
  mockReadRunMetaBySlug: vi.fn((_cwd: string, _slug: string, _onWarning?: (message: string) => void) => null),
  mockResolveTaskWorkflowValue: vi.fn((data?: Record<string, unknown>) => (
    typeof data?.workflow === 'string' ? data.workflow : undefined
  )),
  mockLoadWorkflowByIdentifier: vi.fn((_identifier: string, _projectDir: string, _options?: { lookupCwd?: string }): WorkflowConfig | null => null),
  mockResolveTaskOrderContent: vi.fn((_projectDir: string, _taskDir: string | undefined, _content: string) => 'Canonical order'),
  mockAssertReusableWorktreePath: vi.fn((_projectDir: string, _worktreePath: string) => undefined),
}));

vi.mock('../infra/task/index.js', () => ({
  resolveTaskWorkflowValue: (data?: Record<string, unknown>) => mockResolveTaskWorkflowValue(data),
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: (identifier: string, projectDir: string, options?: { lookupCwd?: string }) =>
    mockLoadWorkflowByIdentifier(identifier, projectDir, options),
}));

vi.mock('../core/workflow/run/run-meta.js', () => ({
  readRunMetaBySlug: (cwd: string, slug: string, onWarning?: (message: string) => void) =>
    mockReadRunMetaBySlug(cwd, slug, onWarning),
}));

vi.mock('../core/workflow/workflow-reference.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  workflowEntryMatchesWorkflow: vi.fn(() => false),
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
  assertReusableWorktreePath: (projectDir: string, worktreePath: string) =>
    mockAssertReusableWorktreePath(projectDir, worktreePath),
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

  it('rejects a non-failed task before touching its worktree', () => {
    const task: TaskListItem = { ...failedTask, kind: 'exceeded' };

    expect(() => prepareFailedTaskRetry(task, '/project'))
      .toThrow('Failed task retry action requires failed task. received: exceeded');
    expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
  });
});
