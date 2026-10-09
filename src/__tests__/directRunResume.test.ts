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
  mockWarn,
  mockExecuteTaskWithResult,
  mockLoadWorkflowByIdentifier,
  mockGetWorkflowDescription,
  mockReadRunContextOrderContent,
  mockLoadRunSessionContext,
  mockFormatRunSessionForPrompt,
  mockRunDirectRetryMode,
  mockRunDirectInstructMode,
  mockLocalBranchExists,
  mockMaterializePullRequestBase,
  mockGetCurrentBranch,
  mockResolveWorkflowCallTarget,
} = vi.hoisted(() => ({
  mockFindLatestResumableDirectRun: vi.fn(),
  mockSelectOption: vi.fn(),
  mockInfo: vi.fn(),
  mockHeader: vi.fn(),
  mockBlankLine: vi.fn(),
  mockWarn: vi.fn(),
  mockExecuteTaskWithResult: vi.fn(),
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockGetWorkflowDescription: vi.fn(() => ({
    name: 'default',
    description: '',
    workflowStructure: '',
    stepPreviews: [],
  })),
  mockReadRunContextOrderContent: vi.fn(),
  mockLoadRunSessionContext: vi.fn(),
  mockFormatRunSessionForPrompt: vi.fn(),
  mockRunDirectRetryMode: vi.fn(),
  mockRunDirectInstructMode: vi.fn(),
  mockLocalBranchExists: vi.fn(() => true),
  mockMaterializePullRequestBase: vi.fn((_projectCwd, _targetCwd, baseBranch: string) =>
    `refs/takt/pr-base/${baseBranch}`),
  mockGetCurrentBranch: vi.fn(() => 'feature/direct-resume'),
  mockResolveWorkflowCallTarget: vi.fn(),
}));

vi.mock('../features/tasks/resume/directRunFinder.js', () => ({
  findLatestResumableDirectRun: mockFindLatestResumableDirectRun,
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: mockSelectOption,
  selectOptionWithDefault: mockSelectOption,
}));

vi.mock('../shared/ui/index.js', () => ({
  info: mockInfo,
  header: mockHeader,
  blankLine: mockBlankLine,
  warn: mockWarn,
  status: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeTaskWithResult: mockExecuteTaskWithResult,
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: mockLoadWorkflowByIdentifier,
  getWorkflowDescription: mockGetWorkflowDescription,
  resolveWorkflowConfigValue: vi.fn(() => 3),
  resolveWorkflowCallTarget: mockResolveWorkflowCallTarget,
}));

vi.mock('../infra/config/loaders/workflowCallResolver.js', () => ({
  resolveWorkflowCallTarget: mockResolveWorkflowCallTarget,
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
  getCurrentBranch: (...args: Parameters<typeof mockGetCurrentBranch>) => mockGetCurrentBranch(...args),
  localBranchExists: (...args: Parameters<typeof mockLocalBranchExists>) => mockLocalBranchExists(...args),
  materializePullRequestBase: (...args: Parameters<typeof mockMaterializePullRequestBase>) => (
    mockMaterializePullRequestBase(...args)
  ),
}));

import { resumeDirectRun } from '../features/tasks/resume/index.js';

const resumePoint: WorkflowResumePoint = {
  version: 2,
  stack: [
    { workflow: 'default', workflow_ref: 'default', step: 'review', kind: 'agent', occurrence: 1 },
  ],
  iteration: 4,
  elapsed_ms: 1000,
  workflow_call_invocations: {},
  workflow_step_participations: {},
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
    mockSelectOption.mockReset();
    mockResolveWorkflowCallTarget.mockReset().mockReturnValue(null);
    mockRunDirectRetryMode.mockReset().mockResolvedValue({ action: 'cancel', task: '' });
    mockRunDirectInstructMode.mockReset().mockResolvedValue({ action: 'cancel', task: '' });
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

    expect(mockInfo).toHaveBeenCalled();
    expect(mockSelectOption).not.toHaveBeenCalled();
  });

  it('Given a resumable direct run, When the menu is shown, Then only direct-run actions are offered', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun());
    mockSelectOption.mockResolvedValueOnce('cancel');

    await resumeDirectRun('/project');

    const options = mockSelectOption.mock.calls[0]?.[1] as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual([
      'requeue',
      'retry',
      'instruct',
      'view_reports',
      'cancel',
    ]);
  });

  it('Given invalid timestamps contain terminal controls, When the run summary is printed, Then timestamps are sanitized', async () => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      startTime: '\x1b[31minvalid\x1b[0m\nstarted',
      updatedAt: '\x1b]0;title\x07invalid\rupdated',
    }));
    mockSelectOption.mockResolvedValueOnce('cancel');

    await resumeDirectRun('/project');

    const infoValues = mockInfo.mock.calls.flat().map((value) => String(value));
    for (const value of infoValues) {
      expect(value).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    }
    const infoText = infoValues.join('');
    expect(infoText).toContain('invalid\\nstarted');
    expect(infoText).toContain('invalid\\rupdated');
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

  it('Given a nested resume point is selected for requeue, Then the root call and full checkpoint are forwarded', async () => {
    const childWorkflow: WorkflowConfig = {
      name: 'child',
      subworkflow: { callable: true },
      initialStep: 'review',
      maxSteps: 20,
      steps: [
        { name: 'review', personaDisplayName: 'Reviewer', instruction: 'Review', rules: [] },
      ],
    };
    const parentWorkflow: WorkflowConfig = {
      ...workflow,
      steps: [
        {
          name: 'parent-call',
          kind: 'workflow_call',
          personaDisplayName: 'Child workflow',
          instruction: 'Call child workflow',
          call: 'child',
          rules: [],
        },
        ...workflow.steps,
      ],
    };
    const nestedResumePoint: WorkflowResumePoint = {
      ...resumePoint,
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'default',
          step: 'parent-call',
          kind: 'workflow_call',
          occurrence: 2,
        },
        {
          workflow: 'child',
          workflow_ref: 'child',
          step: 'review',
          kind: 'agent',
          occurrence: 3,
        },
      ],
    };
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(parentWorkflow);
    mockResolveWorkflowCallTarget.mockReturnValueOnce(childWorkflow);
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      currentStep: 'parent-call',
      resumePoint: nestedResumePoint,
    }));
    mockSelectOption.mockResolvedValueOnce('requeue');

    await resumeDirectRun('/project');

    expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
      startStep: 'parent-call',
      resumePoint: nestedResumePoint,
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

  it.each(['plan', 'fix'])('should explicitly restart direct Requeue at %s after a saved step is renamed', async (selectedStep) => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      currentStep: 'fix',
      resumePoint: {
        ...resumePoint,
        stack: [
          { workflow: 'default', workflow_ref: 'default', step: 'reviewers', kind: 'agent', occurrence: 1 },
        ],
      },
    }));
    mockSelectOption.mockResolvedValueOnce('requeue');
    mockSelectOption.mockImplementationOnce(async (_message, options: Array<{ label: string; value: string }>) => {
      expect(mockWarn.mock.calls.flat().join('\n')).toMatch(/reviewers/);
      return options.find((option) => option.label.trim() === JSON.stringify(selectedStep))!.value;
    });

    await resumeDirectRun('/project');

    const execution = mockExecuteTaskWithResult.mock.calls[0]?.[0];
    expect(execution).toEqual(expect.objectContaining({
      restartPoint: {
        stack: [{ workflow: 'default', workflow_ref: 'default', step: selectedStep, kind: 'agent' }],
      },
    }));
    expect(execution?.resumePoint).toBeUndefined();
    expect(execution?.startStep).toBeUndefined();
  });

  it.each(['requeue', 'retry', 'instruct'])('should cancel direct %s without a start picker when no restart target exists', async (action) => {
    mockLoadWorkflowByIdentifier.mockReturnValue({
      ...workflow, initialStep: 'publish',
      steps: [{ name: 'publish', kind: 'system', personaDisplayName: 'publish', instruction: '', effects: [{ type: 'merge_pr', pr: 42 }] }],
    });
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({ resumePoint: {
      ...resumePoint,
      stack: [{ workflow: 'default', workflow_ref: 'default', step: 'reviewers', kind: 'agent', occurrence: 1 }],
    } }));
    mockSelectOption.mockResolvedValueOnce(action);

    expect(await resumeDirectRun('/project')).toBe(false);
    expect(mockSelectOption).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls.flat().join('\n')).toMatch(/reviewers.*not found/i);
    expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
    expect(mockRunDirectRetryMode).not.toHaveBeenCalled();
    expect(mockRunDirectInstructMode).not.toHaveBeenCalled();
  });

  describe('terminal workflow_call resolution', () => {
    const parent: WorkflowConfig = {
      ...workflow,
      steps: [workflow.steps[0]!, { name: 'delegate', kind: 'workflow_call', call: 'child', instruction: '', personaDisplayName: 'delegate' }],
    };
    const point: WorkflowResumePoint = {
      ...resumePoint,
      stack: [
        { workflow: 'default', workflow_ref: 'default', step: 'delegate', kind: 'workflow_call', occurrence: 3, call_instance: 3, step_iterations: { delegate: 3 } },
        { workflow: 'child', workflow_ref: 'child', step: 'review', kind: 'agent', occurrence: 2 },
      ],
      iteration: 9, elapsed_ms: 3000,
      workflow_call_invocations: { delegate: { call_instance: 3, report_namespace_segment: 'delegate-3' } },
      workflow_step_participations: { delegate: { report_names: ['review.md'] } },
    };

    beforeEach(() => {
      mockLoadWorkflowByIdentifier.mockReturnValue(parent);
      mockFindLatestResumableDirectRun.mockReturnValue(createRun({ resumePoint: point }));
    });

    describe.each(['terminal call', 'valid child checkpoint', 'removed child checkpoint'] as const)('%s callable validation', (position) => {
      const savedPoint = position === 'terminal call' ? { ...point, stack: [point.stack[0]!] } : point;
      const child: WorkflowConfig = {
        name: 'child', initialStep: 'plan', maxSteps: 10,
        steps: position === 'valid child checkpoint' ? workflow.steps : [workflow.steps[0]!],
      };

      beforeEach(() => {
        mockFindLatestResumableDirectRun.mockReturnValue(createRun({ resumePoint: savedPoint }));
      });

      it('should adopt only callable children and preserve saved state', async () => {
        mockResolveWorkflowCallTarget.mockReturnValue({ ...child, subworkflow: { callable: true } });
        mockSelectOption.mockResolvedValueOnce('requeue');

        expect(await resumeDirectRun('/project')).toBe(true);
        expect(mockSelectOption).toHaveBeenCalledTimes(1);
        expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
          startStep: 'delegate',
          resumePoint: {
            ...savedPoint,
            stack: position === 'removed child checkpoint' ? [point.stack[0]!] : savedPoint.stack,
          },
          restartPoint: undefined,
        }));
      });

      it.each([
        { name: 'callable false', subworkflow: { callable: false } },
        { name: 'callable omitted', subworkflow: {} },
        { name: 'subworkflow omitted', subworkflow: undefined },
      ])('should explain $name and explicitly restart instead of adopting the checkpoint', async ({ subworkflow }) => {
        mockResolveWorkflowCallTarget.mockReturnValue({ ...child, subworkflow });
        mockSelectOption.mockResolvedValueOnce('requeue');
        mockSelectOption.mockImplementationOnce(async (_message, options: Array<{ label: string; value: string }>) => {
          const warning = mockWarn.mock.calls.flat().join('\n');
          expect(warning).toMatch(/child.*not callable/i);
          expect(warning).toMatch(/saved resume information cannot be carried forward/i);
          expect(options.some((option) => option.value === 'resume-checkpoint')).toBe(false);
          return options.find((option) => option.label === '"plan"')!.value;
        });

        expect(await resumeDirectRun('/project')).toBe(true);
        expect(mockSelectOption).toHaveBeenCalledTimes(2);
        expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
          restartPoint: { stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }] },
          resumePoint: undefined, startStep: undefined,
        }));
      });
    });

    describe('non-callable child actions', () => {
      beforeEach(() => {
        mockResolveWorkflowCallTarget.mockReturnValue({
          name: 'child', initialStep: 'review', maxSteps: 10,
          subworkflow: { callable: false }, steps: workflow.steps,
        });
      });

      it.each(['requeue', 'retry', 'instruct'])('should execute the explicit restart after %s', async (action) => {
        mockSelectOption.mockResolvedValueOnce(action);
        mockSelectOption.mockImplementationOnce(async (_message, options: Array<{ label: string; value: string }>) => (
          options.find((option) => option.label === '"plan"')!.value
        ));
        mockRunDirectRetryMode.mockResolvedValueOnce({ action: 'execute', task: 'Retry instruction' });
        mockRunDirectInstructMode.mockResolvedValueOnce({ action: 'execute', task: 'Additional instruction' });

        expect(await resumeDirectRun('/project')).toBe(true);
        expect(mockRunDirectRetryMode).toHaveBeenCalledTimes(action === 'retry' ? 1 : 0);
        expect(mockRunDirectInstructMode).toHaveBeenCalledTimes(action === 'instruct' ? 1 : 0);
        expect(mockExecuteTaskWithResult).toHaveBeenCalledTimes(1);
        expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
          restartPoint: { stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }] },
          resumePoint: undefined, startStep: undefined,
          resumeSource: expect.objectContaining({ resumeMode: action }),
          retryNote: action === 'retry' ? 'Retry instruction' : action === 'instruct' ? 'Additional instruction' : undefined,
        }));
      });

      it.each(['requeue', 'retry', 'instruct'])('should cancel %s before conversation or execution', async (action) => {
        mockSelectOption.mockResolvedValueOnce(action).mockResolvedValueOnce(null);

        expect(await resumeDirectRun('/project')).toBe(false);
        expect(mockSelectOption).toHaveBeenCalledTimes(2);
        expect(mockWarn.mock.calls.flat().join('\n')).toMatch(/child.*not callable/i);
        expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
        expect(mockRunDirectRetryMode).not.toHaveBeenCalled();
        expect(mockRunDirectInstructMode).not.toHaveBeenCalled();
      });

      it.each(['requeue', 'retry', 'instruct'])('should cancel %s without a picker when no restart candidate exists', async (action) => {
        mockLoadWorkflowByIdentifier.mockReturnValue({ ...parent, initialStep: 'delegate', steps: [parent.steps[1]!] });
        mockSelectOption.mockResolvedValueOnce(action);

        expect(await resumeDirectRun('/project')).toBe(false);
        const warning = mockWarn.mock.calls.flat().join('\n');
        expect(warning).toMatch(/child.*not callable/i);
        expect(warning).toMatch(/saved resume information cannot be carried forward/i);
        expect(mockSelectOption).toHaveBeenCalledTimes(1);
        expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
        expect(mockRunDirectRetryMode).not.toHaveBeenCalled();
        expect(mockRunDirectInstructMode).not.toHaveBeenCalled();
      });
    });

    it('should retain parent call state when only the child checkpoint is removed', async () => {
      mockResolveWorkflowCallTarget.mockReturnValue({
        name: 'child', initialStep: 'plan', maxSteps: 10, subworkflow: { callable: true }, steps: [workflow.steps[0]!],
      });
      mockSelectOption.mockResolvedValueOnce('requeue');

      expect(await resumeDirectRun('/project')).toBe(true);
      expect(mockSelectOption).toHaveBeenCalledTimes(1);
      expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
        startStep: 'delegate', resumePoint: { ...point, stack: [point.stack[0]!] }, restartPoint: undefined,
      }));
    });

    it.each(['null', 'throw'] as const)('should offer an explicit restart when the callee resolver returns %s', async (failure) => {
      mockResolveWorkflowCallTarget.mockImplementation(() => {
        if (failure === 'throw') throw new Error('child definition unavailable');
        return null;
      });
      mockSelectOption.mockResolvedValueOnce('requeue');
      mockSelectOption.mockImplementationOnce(async (_message, options: Array<{ label: string; value: string }>) => {
        expect(mockWarn.mock.calls.flat().join('\n')).toMatch(/child/);
        expect(options.some((option) => option.value === 'resume-checkpoint')).toBe(false);
        return options.find((option) => option.label === '"plan"')!.value;
      });

      expect(await resumeDirectRun('/project')).toBe(true);
      expect(mockSelectOption).toHaveBeenCalledTimes(2);
      expect(mockExecuteTaskWithResult).toHaveBeenCalledWith(expect.objectContaining({
        restartPoint: { stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }] },
        resumePoint: undefined, startStep: undefined,
      }));
    });

    it.each(['requeue', 'retry', 'instruct'])('should cancel %s after explaining an unavailable callee', async (action) => {
      mockSelectOption.mockResolvedValueOnce(action).mockResolvedValueOnce(null);

      expect(await resumeDirectRun('/project')).toBe(false);
      expect(mockWarn.mock.calls.flat().join('\n')).toMatch(/child/);
      expect(mockSelectOption).toHaveBeenCalledTimes(2);
      expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
      expect(mockRunDirectRetryMode).not.toHaveBeenCalled();
      expect(mockRunDirectInstructMode).not.toHaveBeenCalled();
    });
  });

  it.each(['requeue', 'retry', 'instruct'])('should cancel direct %s before execution or conversation when saved resume information is invalid', async (action) => {
    mockFindLatestResumableDirectRun.mockReturnValue(createRun({
      resumePoint: {
        ...resumePoint,
        stack: [{ workflow: 'default', workflow_ref: 'default', step: 'reviewers', kind: 'agent', occurrence: 1 }],
      },
    }));
    mockSelectOption.mockResolvedValueOnce(action);
    mockSelectOption.mockResolvedValueOnce(null);

    const result = await resumeDirectRun('/project');

    expect(result).toBe(false);
    expect(mockSelectOption).toHaveBeenCalledTimes(2);
    expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
    expect(mockRunDirectRetryMode).not.toHaveBeenCalled();
    expect(mockRunDirectInstructMode).not.toHaveBeenCalled();
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

    const overrides = { provider: 'mock' as const, model: 'mock-selector' };
    await resumeDirectRun('/project', overrides);

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
      agentOverrides: overrides,
      retryNote: 'Retry with failing spec fixed',
      resumeSource: {
        sourceRunSlug: '20260524-direct-failed',
        resumeMode: 'retry',
      },
    }));
    expect(mockGetWorkflowDescription).toHaveBeenCalledWith(
      'default',
      '/project',
      3,
      '/project',
      overrides,
    );
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

    const infoText = mockInfo.mock.calls.flat().map((value) => String(value)).join('\n');
    expect(infoText).toContain('.takt/runs/20260524-direct-failed');
    expect(infoText).toContain('/reports');
    expect(infoText).toContain('/logs');
    expect(infoText).toContain('/meta.json');
    expect(mockExecuteTaskWithResult).not.toHaveBeenCalled();
  });
});
