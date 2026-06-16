import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';

const {
  mockFindLatestResumableDirectRun,
  mockSelectOption,
  mockInfo,
  mockHeader,
  mockBlankLine,
  mockExecuteTaskWithResult,
  mockLoadWorkflowByIdentifier,
  mockReadRunContextOrderContent,
  mockLoadRunSessionContext,
  mockFormatRunSessionForPrompt,
  mockRunDirectRetryMode,
  mockRunDirectInstructMode,
} = vi.hoisted(() => ({
  mockFindLatestResumableDirectRun: vi.fn(),
  mockSelectOption: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockBlankLine: vi.fn(),
  mockExecuteTaskWithResult: vi.fn(),
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockReadRunContextOrderContent: vi.fn(),
  mockLoadRunSessionContext: vi.fn(),
  mockFormatRunSessionForPrompt: vi.fn(),
  mockRunDirectRetryMode: vi.fn(),
  mockRunDirectInstructMode: vi.fn(),
}));

vi.mock('../features/tasks/resume/directRunFinder.js', () => ({
  findLatestResumableDirectRun: mockFindLatestResumableDirectRun,
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: mockInfo,
  header: mockHeader,
  blankLine: mockBlankLine,
  status: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTaskWithResult: mockExecuteTaskWithResult,
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: mockLoadWorkflowByIdentifier,
  getWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: '',
    workflowStructure: '',
    stepPreviews: [],
  })),
  resolveWorkflowConfigValue: vi.fn(() => 3),
}));

vi.mock('../core/workflow/run/order-content.js', () => ({
  readRunContextOrderContent: mockReadRunContextOrderContent,
}));

vi.mock('../features/interactive/index.js', () => ({
  loadRunSessionContext: mockLoadRunSessionContext,
  formatRunSessionForPrompt: mockFormatRunSessionForPrompt,
  runDirectRetryMode: mockRunDirectRetryMode,
}));

vi.mock('../features/tasks/resume/directInstructMode.js', () => ({
  runDirectInstructMode: mockRunDirectInstructMode,
}));

import { resumeDirectRun } from '../features/tasks/resume/index.js';

const resumePoint: WorkflowResumePoint = {
  version: 1,
  stack: [
    { workflow: 'default', step: 'review', kind: 'agent' },
  ],
  iteration: 4,
  elapsed_ms: 1000,
};

const workflow: WorkflowConfig = {
  name: 'default',
  initialStep: 'plan',
  maxSteps: 50,
  steps: [
    { name: 'plan', personaDisplayName: 'Planner', instruction: 'Plan', rules: [] },
    { name: 'review', personaDisplayName: 'Reviewer', instruction: 'Review', rules: [] },
    { name: 'fix', personaDisplayName: 'Fixer', instruction: 'Fix', rules: [] },
  ],
};

function createRun(overrides?: Record<string, unknown>) {
  return {
    slug: '20260524-direct-failed',
    meta: {
      task: 'Meta task instruction',
      workflow: 'default',
      runSlug: '20260524-direct-failed',
      runRoot: '.takt/runs/20260524-direct-failed',
      reportDirectory: '.takt/runs/20260524-direct-failed/reports',
      contextDirectory: '.takt/runs/20260524-direct-failed/context',
      logsDirectory: '.takt/runs/20260524-direct-failed/logs',
      status: 'aborted',
      startTime: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:10:00.000Z',
      currentStep: 'fix',
      currentIteration: 5,
      iterations: 50,
      resumePoint,
      ...overrides,
    },
  };
}

describe('resumeDirectRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWorkflowByIdentifier.mockReturnValue(workflow);
    mockExecuteTaskWithResult.mockResolvedValue({ success: true });
    mockReadRunContextOrderContent.mockReturnValue('Order file instruction');
    mockLoadRunSessionContext.mockReturnValue({ task: 'run task' });
    mockFormatRunSessionForPrompt.mockReturnValue({
      runTask: 'run task',
      runWorkflow: 'default',
      runStatus: 'aborted',
      runStepLogs: 'step logs',
      runReports: 'reports',
    });
  });

  it('Given no resumable direct run, When resume is invoked, Then the guidance message is printed', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(null);

    await resumeDirectRun('/project');

    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith('No resumable direct run found. Use `takt list` for queued tasks.');
    expect(mockSelectOption).not.toHaveBeenCalled();
  });

  it('Given a resumable direct run, When the menu is shown, Then only direct-run actions are offered', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('cancel');

    await resumeDirectRun('/project');

    expect(mockHeader).toHaveBeenCalledWith('Direct run');
    expect(mockSelectOption.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ label: 'Requeue', value: 'requeue' }),
      expect.objectContaining({ label: 'Retry', value: 'retry' }),
      expect.objectContaining({ label: 'Instruct', value: 'instruct' }),
      expect.objectContaining({ label: 'View reports', value: 'view_reports' }),
      expect.objectContaining({ label: 'Cancel', value: 'cancel' }),
    ]);
    const labels = (mockSelectOption.mock.calls[0]?.[1] as Array<{ label: string }>).map((option) => option.label);
    expect(labels).not.toContain('Try Merge');
    expect(labels).not.toContain('Merge');
    expect(labels).not.toContain('Pull');
    expect(labels).not.toContain('Sync');
    expect(labels).not.toContain('Create PR');
  });

  it('Given a resumable direct run, When the menu is shown, Then the run summary is printed', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('cancel');

    await resumeDirectRun('/project');

    expect(mockInfo).toHaveBeenCalledWith('Status: aborted');
    expect(mockInfo).toHaveBeenCalledWith('Workflow: default');
    expect(mockInfo).toHaveBeenCalledWith('Step: fix');
    expect(mockInfo).toHaveBeenCalledWith('Iteration: 5/50');
    expect(mockInfo).toHaveBeenCalledWith('Run: 20260524-direct-failed');
    expect(mockInfo).toHaveBeenCalledWith('Path: .takt/runs/20260524-direct-failed');
    expect(mockInfo).toHaveBeenCalledWith('Started: 2026-05-24 00:00');
    expect(mockInfo).toHaveBeenCalledWith('Updated: 2026-05-24 00:10');
  });

  it('Given invalid timestamps contain terminal controls, When the run summary is printed, Then timestamps are sanitized', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      startTime: '\x1b[31minvalid\x1b[0m\nstarted',
      updatedAt: '\x1b]0;title\x07invalid\rupdated',
    }));
    mockSelectOption.mockResolvedValueOnce('cancel');

    await resumeDirectRun('/project');

    expect(mockInfo).toHaveBeenCalledWith('Started: invalid\\nstarted');
    expect(mockInfo).toHaveBeenCalledWith('Updated: invalid\\rupdated');
  });

  it('Given Requeue is selected, When order.md exists, Then direct execution uses the order content and source metadata', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project', { provider: 'mock', model: 'gpt-test' });

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Order file instruction',
      cwd: '/project',
      projectCwd: '/project',
      workflowIdentifier: 'default',
      agentOverrides: { provider: 'mock', model: 'gpt-test' },
      resumePoint,
      startStep: 'review',
      directResume: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'requeue',
      },
      traceTaskMetadata: {
        taskSlug: '20260524-direct-failed',
        taskSummary: 'Order file instruction',
        taskSource: 'manual',
      },
    }));
  });

  it('Given Requeue is selected without a valid resume point, When currentStep exists in the workflow, Then currentStep is used as startStep', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ resumePoint: undefined }));
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      startStep: 'fix',
      resumePoint: undefined,
    }));
  });

  it('Given Requeue is selected with an inconsistent resume point and no currentStep, When resume runs, Then the workflow initial step is used', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      currentStep: undefined,
      resumePoint: {
        ...resumePoint,
        stack: [
          { workflow: 'other-workflow', step: 'missing', kind: 'agent' },
        ],
      },
    }));
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      startStep: undefined,
      resumePoint: undefined,
    }));
  });

  it('Given Requeue is selected without resume point or currentStep, When resume runs, Then the workflow initial step is used', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      currentStep: undefined,
      resumePoint: undefined,
    }));
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      startStep: undefined,
      resumePoint: undefined,
    }));
  });

  it('Given Requeue is selected and order.md is absent, When meta.task exists, Then meta.task is used as the instruction', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockReadRunContextOrderContent.mockReturnValue(undefined);
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Meta task instruction',
    }));
  });

  it('Given Retry is selected, When conversation returns a retry note, Then the note is passed to direct execution', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ status: 'failed' }));
    mockSelectOption.mockResolvedValueOnce('retry');
    mockRunDirectRetryMode.mockResolvedValueOnce({ action: 'execute', task: 'Retry with failing spec fixed' });

    await resumeDirectRun('/project');

    expect(mockRunDirectRetryMode).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        previousOrderContent: 'Order file instruction',
        subject: {
          kind: 'run',
          value: '20260524-direct-failed',
        },
        run: expect.objectContaining({
          status: 'aborted',
          stepLogs: 'step logs',
          reports: 'reports',
        }),
      }),
    );
    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      retryNote: 'Retry with failing spec fixed',
      directResume: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'retry',
      },
    }));
  });

  it('Given Instruct is selected, When conversation returns additional instructions, Then the instructions are passed as retryNote', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('instruct');
    mockRunDirectInstructMode.mockResolvedValueOnce({ action: 'execute', task: 'Also update regression coverage' });

    await resumeDirectRun('/project');

    expect(mockRunDirectInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project',
      runSlug: '20260524-direct-failed',
      taskContent: 'Order file instruction',
      previousOrderContent: 'Order file instruction',
    }));
    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      retryNote: 'Also update regression coverage',
      directResume: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'instruct',
      },
    }));
  });

  it('Given Retry is selected and order.md is absent, When meta.task is used, Then previousOrderContent is not passed as order.md', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockReadRunContextOrderContent.mockReturnValue(undefined);
    mockSelectOption.mockResolvedValueOnce('retry');
    mockRunDirectRetryMode.mockResolvedValueOnce({ action: 'cancel', task: '' });

    await resumeDirectRun('/project');

    expect(mockRunDirectRetryMode).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        failure: expect.objectContaining({
          taskContent: 'Meta task instruction',
        }),
        previousOrderContent: null,
      }),
    );
  });

  it('Given Instruct is selected and order.md is absent, When meta.task is used, Then previousOrderContent is null', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockReadRunContextOrderContent.mockReturnValue(undefined);
    mockSelectOption.mockResolvedValueOnce('instruct');
    mockRunDirectInstructMode.mockResolvedValueOnce({ action: 'cancel', task: '' });

    await resumeDirectRun('/project');

    expect(mockRunDirectInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      taskContent: 'Meta task instruction',
      previousOrderContent: null,
    }));
  });

  it('Given View reports is selected, When resume is invoked, Then only run paths are printed', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('view_reports');

    await resumeDirectRun('/project');

    expect(mockInfo).toHaveBeenCalledWith('Run: .takt/runs/20260524-direct-failed');
    expect(mockInfo).toHaveBeenCalledWith('Reports: .takt/runs/20260524-direct-failed/reports');
    expect(mockInfo).toHaveBeenCalledWith('Logs: .takt/runs/20260524-direct-failed/logs');
    expect(mockInfo).toHaveBeenCalledWith('Meta: .takt/runs/20260524-direct-failed/meta.json');
    expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
  });
});
