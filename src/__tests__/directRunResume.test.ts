import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';
import type { TaskAttachment } from '../features/tasks/attachments.js';
import { withAttachmentCleanup } from './testUtils/attachmentTestHelpers.js';

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
  mockLocalBranchExists,
  mockMaterializePullRequestBase,
  mockGetCurrentBranch,
  mockReconcilePendingWorkflowRuns,
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
  mockLocalBranchExists: vi.fn(() => true),
  mockMaterializePullRequestBase: vi.fn((_projectCwd, _targetCwd, baseBranch: string) =>
    `refs/takt/pr-base/${baseBranch}`),
  mockGetCurrentBranch: vi.fn(() => 'feature/direct-resume'),
  mockReconcilePendingWorkflowRuns: vi.fn(),
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

vi.mock('../features/tasks/execute/workflowRunStorage.js', () => ({
  reconcilePendingWorkflowRuns: mockReconcilePendingWorkflowRuns,
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

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  localBranchExists: (...args: unknown[]) => mockLocalBranchExists(...args),
  materializePullRequestBase: (...args: unknown[]) => mockMaterializePullRequestBase(...args),
}));

import { resumeDirectRun } from '../features/tasks/resume/index.js';

const resumePoint: WorkflowResumePoint = {
  version: 1,
  stack: [
    { workflow: 'default', workflow_ref: 'default', step: 'review', kind: 'agent', occurrence: 1 },
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

const pullRequestContext = {
  source: 'pr_review' as const,
  prNumber: 861,
  baseBranch: 'release/2026.07',
  headBranch: 'feature/direct-resume',
  baseBranchSource: 'pull_request' as const,
};

const tempRoots = new Set<string>();

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
      storageBackend: 'file',
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

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-direct-resume-test-'));
  tempRoots.add(root);
  return root;
}

function createAttachment(root: string, content: string): TaskAttachment {
  const attachmentDir = path.join(root, 'tmp-attachments');
  fs.mkdirSync(attachmentDir, { recursive: true });
  const tempPath = path.join(attachmentDir, 'image-1.png');
  fs.writeFileSync(tempPath, content, 'utf-8');
  return {
    placeholder: '[Image #1]',
    tempPath,
    fileName: 'image-1.png',
  };
}

function expectPromotedAttachment(projectDir: string, content: string, imageIndex = 1): void {
  const executeArg = mockExecuteTaskWithResult.mock.calls[0]?.[0] as {
    task: string;
    reportDirName: string;
    taskSpec: {
      stagedOrderContent: string;
      sourceTaskDir: string;
    };
  };
  const fileName = `image-${imageIndex}.png`;
  expect(executeArg.task).toContain(`.takt/runs/${executeArg.reportDirName}/context/task`);
  expect(executeArg.taskSpec.stagedOrderContent).toContain(content);
  expect(executeArg.taskSpec.stagedOrderContent).toContain(
    `.takt/runs/${executeArg.reportDirName}/context/task/attachments/${fileName}`,
  );
  expect(fs.existsSync(executeArg.taskSpec.sourceTaskDir)).toBe(false);
  expect(fs.existsSync(
    path.join(projectDir, '.takt', 'runs', executeArg.reportDirName),
  )).toBe(false);
  expect(fs.existsSync(path.join(projectDir, '.takt', 'tasks'))).toBe(false);
}

describe('resumeDirectRun', () => {
  afterEach(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

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

    expect(mockReconcilePendingWorkflowRuns).toHaveBeenCalledWith({
      cwd: '/project',
    });
    expect(
      mockReconcilePendingWorkflowRuns.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockFindLatestResumableDirectRun.mock.invocationCallOrder[0]!);
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
      resumeSource: {
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

  it('Given a PR-derived run is requeued, Then execution reuses the persisted PR context', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ prContext: pullRequestContext }));
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      prContext: {
        ...pullRequestContext,
        baseDiffRef: 'refs/takt/pr-base/release/2026.07',
        headDiffRef: 'refs/heads/feature/direct-resume',
      },
    }));
  });

  it('Given a PR-derived run is retried, Then retry conversation receives the materialized PR context', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ prContext: pullRequestContext }));
    mockSelectOption.mockResolvedValueOnce('retry');
    mockRunDirectRetryMode.mockResolvedValueOnce({ action: 'cancel', task: '' });

    await resumeDirectRun('/project');

    expect(mockRunDirectRetryMode).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({
        prContext: {
          ...pullRequestContext,
          baseDiffRef: 'refs/takt/pr-base/release/2026.07',
          headDiffRef: 'refs/heads/feature/direct-resume',
        },
      }),
    );
  });

  it('Given a PR-derived run is instructed, Then instruct conversation receives the materialized PR context', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ prContext: pullRequestContext }));
    mockSelectOption.mockResolvedValueOnce('instruct');
    mockRunDirectInstructMode.mockResolvedValueOnce({ action: 'cancel', task: '' });

    await resumeDirectRun('/project');

    expect(mockRunDirectInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      prContext: {
        ...pullRequestContext,
        baseDiffRef: 'refs/takt/pr-base/release/2026.07',
        headDiffRef: 'refs/heads/feature/direct-resume',
      },
    }));
  });

  it('Given a non-PR run is resumed, Then PR context is not inherited by any resume mode', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());

    mockSelectOption.mockResolvedValueOnce('requeue');
    await resumeDirectRun('/project');
    expect(mockExecuteTaskWithResult.mock.calls[0]?.[0]).not.toHaveProperty('prContext');

    mockSelectOption.mockResolvedValueOnce('retry');
    mockRunDirectRetryMode.mockResolvedValueOnce({ action: 'cancel', task: '' });
    await resumeDirectRun('/project');
    expect(mockRunDirectRetryMode.mock.calls[0]?.[1]).not.toHaveProperty('prContext');

    mockSelectOption.mockResolvedValueOnce('instruct');
    mockRunDirectInstructMode.mockResolvedValueOnce({ action: 'cancel', task: '' });
    await resumeDirectRun('/project');
    expect(mockRunDirectInstructMode.mock.calls[0]?.[0]).not.toHaveProperty('prContext');
  });

  it('Given a PR-derived run without its local head ref, Then resume fails before using stale diff refs', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ prContext: pullRequestContext }));
    mockSelectOption.mockResolvedValueOnce('requeue');
    mockLocalBranchExists.mockReturnValueOnce(false);

    await expect(resumeDirectRun('/project')).rejects.toThrow(
      'Direct run resume is missing PR head ref refs/heads/feature/direct-resume.',
    );
    expect(mockMaterializePullRequestBase).not.toHaveBeenCalled();
    expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
  });

  it('Given a PR-derived run checked out on another branch, Then resume fails before materialization', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ prContext: pullRequestContext }));
    mockSelectOption.mockResolvedValueOnce('requeue');
    mockGetCurrentBranch.mockReturnValueOnce('main');

    await expect(resumeDirectRun('/project')).rejects.toThrow(
      'Direct run resume is checked out on "main", expected PR head "feature/direct-resume".',
    );
    expect(mockLocalBranchExists).not.toHaveBeenCalled();
    expect(mockMaterializePullRequestBase).not.toHaveBeenCalled();
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
          { workflow: 'other-workflow', workflow_ref: 'other-workflow', step: 'missing', kind: 'agent', occurrence: 1 },
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
    const cleanupAttachments = vi.fn();
    mockRunDirectRetryMode.mockResolvedValueOnce(withAttachmentCleanup({
      action: 'execute',
      task: 'Retry with failing spec fixed',
    }, cleanupAttachments));

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
      resumeSource: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'retry',
      },
    }));
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given Retry is selected and conversation returns image attachments, When direct execution starts, Then attachments are promoted before cleanup', async () => {
    const projectDir = createTempRoot();
    const attachment = createAttachment(projectDir, 'png-data');
    mockReadRunContextOrderContent.mockReturnValue([
      'Order file instruction with [Image #1].',
      '',
      '## 添付画像',
      '',
      '- [Image #1]: `attachments/image-1.png`',
    ].join('\n'));
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ status: 'failed' }));
    mockSelectOption.mockResolvedValueOnce('retry');
    const cleanupAttachments = vi.fn();
    mockRunDirectRetryMode.mockResolvedValueOnce(withAttachmentCleanup({
      action: 'execute',
      task: 'Retry with [Image #1]',
      attachments: [attachment],
    }, cleanupAttachments));

    await resumeDirectRun(projectDir);

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      retryNote: 'Retry with [Image #2]',
      reportDirName: expect.any(String),
      resumeSource: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'retry',
      },
    }));
    expectPromotedAttachment(projectDir, 'Retry with [Image #2]', 2);
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given Retry is selected, When direct execution throws, Then conversation attachments are cleaned up', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ status: 'failed' }));
    mockSelectOption.mockResolvedValueOnce('retry');
    const cleanupAttachments = vi.fn();
    mockRunDirectRetryMode.mockResolvedValueOnce(withAttachmentCleanup({
      action: 'execute',
      task: 'Retry with failing spec fixed',
    }, cleanupAttachments));
    mockExecuteTaskWithResult.mockRejectedValueOnce(new Error('direct execution failed'));

    await expect(resumeDirectRun('/project')).rejects.toThrow('direct execution failed');

    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given Instruct is selected, When conversation returns additional instructions, Then the instructions are passed as retryNote', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('instruct');
    const cleanupAttachments = vi.fn();
    mockRunDirectInstructMode.mockResolvedValueOnce(withAttachmentCleanup({
      action: 'execute',
      task: 'Also update regression coverage',
    }, cleanupAttachments));

    await resumeDirectRun('/project');

    expect(mockRunDirectInstructMode).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/project',
      runSlug: '20260524-direct-failed',
      taskContent: 'Order file instruction',
      previousOrderContent: 'Order file instruction',
    }));
    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      retryNote: 'Also update regression coverage',
      resumeSource: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'instruct',
      },
    }));
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
  });

  it('Given Instruct is selected and conversation returns image attachments, When direct execution starts, Then attachments are promoted before cleanup', async () => {
    const projectDir = createTempRoot();
    const attachment = createAttachment(projectDir, 'png-data');
    mockReadRunContextOrderContent.mockReturnValue([
      'Order file instruction with [Image #1].',
      '',
      '## 添付画像',
      '',
      '- [Image #1]: `attachments/image-1.png`',
    ].join('\n'));
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('instruct');
    const cleanupAttachments = vi.fn();
    mockRunDirectInstructMode.mockResolvedValueOnce(withAttachmentCleanup({
      action: 'execute',
      task: 'Also inspect [Image #1]',
      attachments: [attachment],
    }, cleanupAttachments));

    await resumeDirectRun(projectDir);

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      retryNote: 'Also inspect [Image #2]',
      reportDirName: expect.any(String),
      resumeSource: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'instruct',
      },
    }));
    expectPromotedAttachment(projectDir, 'Also inspect [Image #2]', 2);
    expect(cleanupAttachments).toHaveBeenCalledTimes(1);
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
