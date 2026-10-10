/**
 * Tests for how the default CLI action chooses between the Ink TUI and the
 * classic readline conversation.
 *
 * Contract: a TTY always gets the TUI, `--tui`
 * demands a terminal, and without a terminal the classic path always runs so
 * piped input keeps working.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { IssueEnqueueResult } from '../infra/task/enqueueService.js';

const operationMocks = vi.hoisted(() => ({ execute: vi.fn(), save: vi.fn(), issue: vi.fn() }));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const {
  mockGetWorkflowDescription,
  mockResolveAgentOverrides,
  mockRunTui,
  mockLoadTaskHistory,
  mockResolveIssueInput,
  mockLoadWorkflowByIdentifier,
} = vi.hoisted(() => ({
  mockGetWorkflowDescription: vi.fn(),
  mockResolveAgentOverrides: vi.fn(),
  mockRunTui: vi.fn(),
  mockLoadTaskHistory: vi.fn(),
  mockResolveIssueInput: vi.fn(),
  mockLoadWorkflowByIdentifier: vi.fn(),
}));

vi.mock('../features/tui/index.js', () => ({
  runTui: (...args: unknown[]) => mockRunTui(...args),
}));

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: operationMocks.execute,
  determineWorkflow: vi.fn(),
  saveTaskFromInteractive: operationMocks.save,
  createIssueAndSaveTask: operationMocks.issue,
  promptLabelSelection: vi.fn(async () => []),
}));

vi.mock('../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
  selectInteractiveMode: vi.fn(),
  personaMode: vi.fn(),
  resolveLanguage: vi.fn(() => 'en'),
  dispatchConversationAction: vi.fn(async (
    result: { action: string },
    handlers: Record<string, (value: unknown) => unknown>,
  ) => handlers[result.action]!(result)),
}));

vi.mock('../features/interactive/imageAttachments.js', () => ({
  cleanupInteractiveResultAttachments: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
  resolveConfigValue: vi.fn(() => false),
  resolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewSteps: 3 })),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../app/cli/taskHistory.js', () => ({
  loadTaskHistory: (...args: unknown[]) => mockLoadTaskHistory(...args),
}));

vi.mock('../app/cli/routing-inputs.js', () => ({
  resolveIssueInput: (...args: unknown[]) => mockResolveIssueInput(...args),
  resolvePrInput: vi.fn(),
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/test/cwd', pipelineMode: false })),
}));

vi.mock('../app/cli/helpers.js', () => ({
  resolveAgentOverrides: (...args: unknown[]) => mockResolveAgentOverrides(...args),
  isDirectTask: vi.fn(() => false),
  resolveWorkflowCliOption: vi.fn((opts: Record<string, unknown>) =>
    typeof opts.workflow === 'string' ? opts.workflow : undefined),
}));

const mockOpts: Record<string, unknown> = {};

vi.mock('../app/cli/program.js', () => ({
  program: {
    opts: vi.fn(() => mockOpts),
    argument: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  },
}));

import { determineWorkflow, saveTaskFromInteractive, selectAndExecuteTask, promptLabelSelection } from '../features/tasks/index.js';
import { cleanupInteractiveResultAttachments } from '../features/interactive/imageAttachments.js';
import { interactiveMode, personaMode, selectInteractiveMode } from '../features/interactive/index.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { error as logError, info } from '../shared/ui/index.js';
import { describeExecutionResult } from '../features/interactive/operationFeedback.js';

const mockDetermineWorkflow = vi.mocked(determineWorkflow);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockSaveTaskFromInteractive = vi.mocked(saveTaskFromInteractive);
const mockCleanupAttachments = vi.mocked(cleanupInteractiveResultAttachments);
const mockSelectInteractiveMode = vi.mocked(selectInteractiveMode);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockLogError = vi.mocked(logError);

const originalStdinIsTty = process.stdin.isTTY;
const originalStdoutIsTty = process.stdout.isTTY;

function setTerminal(isTty: boolean): void {
  process.stdin.isTTY = isTty;
  process.stdout.isTTY = isTty;
}

function expectExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(promptLabelSelection).mockResolvedValue([]);
  mockSaveTaskFromInteractive.mockReset().mockResolvedValue({ taskName: 'saved-task', tasksFile: '/test/cwd/.takt/tasks.yaml' });
  operationMocks.execute.mockReset().mockResolvedValue({ success: true });
  operationMocks.issue.mockReset().mockResolvedValue({
    success: true,
    created: { taskName: 'issue-task', tasksFile: '/test/cwd/.takt/tasks.yaml', workflow: 'default', issueNumber: 42 },
  });
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  setTerminal(true);
  mockDetermineWorkflow.mockResolvedValue('default');
  mockGetWorkflowDescription.mockReturnValue({
    name: 'default',
    description: 'test workflow',
    workflowStructure: '1. plan',
    stepPreviews: [],
  });
  mockLoadTaskHistory.mockReturnValue([]);
  mockResolveAgentOverrides.mockReturnValue(undefined);
  mockResolveIssueInput.mockResolvedValue(null);
  mockLoadWorkflowByIdentifier.mockReturnValue({ name: 'default', steps: [] });
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockInteractiveMode.mockResolvedValue({ action: 'cancel', task: '' });
  mockRunTui.mockResolvedValue({
    kind: 'selected',
    workflowId: 'default',
    result: { action: 'execute', task: 'tui task' },
  });
});

afterEach(() => {
  process.stdin.isTTY = originalStdinIsTty;
  process.stdout.isTTY = originalStdoutIsTty;
  vi.restoreAllMocks();
});

describe('TUI / classic selection', () => {
  it('should default to the TUI on a terminal without any flag', async () => {
    await executeDefaultAction();

    expect(mockRunTui).toHaveBeenCalled();
    expect(mockSelectInteractiveMode).not.toHaveBeenCalled();
    expect(mockInteractiveMode).not.toHaveBeenCalled();
  });

  it('should use the classic conversation without a terminal so piped input keeps working', async () => {
    setTerminal(false);

    await executeDefaultAction();

    expect(mockRunTui).not.toHaveBeenCalled();
    expect(mockSelectInteractiveMode).toHaveBeenCalled();
  });

  it('should return execution results to the classic conversation', async () => {
    setTerminal(false);
    mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'classic task' });

    await executeDefaultAction();

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'classic task',
      expect.objectContaining({ failureMode: 'return' }),
      undefined,
    );
  });

  it('should use exit failure mode for a direct task option', async () => {
    mockOpts.task = 'direct task';

    await executeDefaultAction();

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'direct task',
      expect.objectContaining({ failureMode: 'exit' }),
      undefined,
    );
  });

  it('should fail fast when --tui is forced without a terminal', async () => {
    mockOpts.tui = true;
    setTerminal(false);
    const exit = expectExit();

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('--tui requires an interactive terminal'),
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(mockResolveIssueInput).not.toHaveBeenCalled();
    expect(mockRunTui).not.toHaveBeenCalled();
  });

  it('should leave the workflow selection to the TUI run itself', async () => {
    await executeDefaultAction();

    // The selector runs inside `runTui`, on the bare terminal, before Ink mounts.
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(mockRunTui).toHaveBeenCalledWith(expect.not.objectContaining({ workflowId: expect.anything() }));
  });
});

describe('TUI routing', () => {
  it('should hand the CLI context to the TUI and let it pick the workflow', async () => {
    await executeDefaultAction('draft task');

    expect(mockRunTui).toHaveBeenCalledWith({
      cwd: '/test/cwd',
      lang: 'en',
      previewCount: 3,
      taskHistory: [],
      userMessage: 'draft task',
      // The session runs each decision through the CLI and stays open.
      dispatch: expect.any(Function),
    });
  });

  it('should pass a CLI-selected workflow and the agent overrides through', async () => {
    mockOpts.workflow = 'review';
    mockResolveAgentOverrides.mockReturnValue({ provider: 'mock', model: 'mock-model' });

    await executeDefaultAction();

    expect(mockRunTui).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'review',
      agentOverrides: { provider: 'mock', model: 'mock-model' },
    }));
  });

  it('should forward --continue so the TUI can resume the assistant session', async () => {
    mockOpts.continue = true;

    await executeDefaultAction();

    expect(mockRunTui).toHaveBeenCalledWith(expect.objectContaining({ continueSession: true }));
  });

  it('should not ask the TUI to resume without --continue', async () => {
    await executeDefaultAction();

    expect(mockRunTui).toHaveBeenCalledWith(
      expect.not.objectContaining({ continueSession: expect.anything() }),
    );
  });

  it('should load an explicit --workflow before starting the TUI', async () => {
    mockOpts.workflow = 'review';

    await executeDefaultAction();

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('review', '/test/cwd');
    expect(mockRunTui).toHaveBeenCalled();
  });

  it.each([
    ['a name', 'missing'],
    ['a relative path', './missing.yaml'],
    ['an absolute path', '/tmp/missing.yaml'],
  ])('should fail fast when --workflow names %s that does not exist', async (_label, workflow) => {
    mockOpts.workflow = workflow;
    mockLoadWorkflowByIdentifier.mockReturnValue(null);
    const exit = expectExit();

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockLogError).toHaveBeenCalledWith(`Workflow not found: ${workflow}`);
    expect(exit).toHaveBeenCalledWith(1);
    expect(mockRunTui).not.toHaveBeenCalled();
  });

  it('should execute with the workflow the TUI returned', async () => {
    mockRunTui.mockResolvedValue({
      kind: 'selected',
      workflowId: 'picked-in-tui',
      result: { action: 'execute', task: 'tui task' },
    });

    await executeDefaultAction();

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'tui task',
      expect.objectContaining({
        workflow: 'picked-in-tui',
        interactiveUserInput: true,
        interactiveMetadata: { confirmed: true, task: 'tui task' },
        failureMode: 'return',
      }),
      undefined,
    );
  });

  it('should dispatch a save_task result from the TUI', async () => {
    const result = {
      action: 'save_task',
      task: 'saved task',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    mockRunTui.mockResolvedValue({ kind: 'selected', workflowId: 'default', result });

    await executeDefaultAction();

    // Saved against the workflow the TUI settled on, with the pasted images.
    expect(mockSaveTaskFromInteractive).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd',
      'saved task',
      'default',
      { allowCancel: true, attachments: result.attachments },
    );
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    // The temp files are released once the task owns them.
    expect(mockCleanupAttachments).toHaveBeenCalledWith(result);
  });

  it('should apply the latest /issue replacement returned by the TUI to execution metadata', async () => {
    mockOpts.issue = 131;
    mockResolveIssueInput.mockResolvedValue({
      initialInput: '## Issue #131: old Issue',
      issueNumber: 131,
    });
    mockRunTui.mockResolvedValue({
      kind: 'selected',
      workflowId: 'default',
      result: {
        action: 'execute',
        task: 'task for Issue #456',
        issueContextReplacement: { issueNumber: 456 },
      },
    });

    await executeDefaultAction();

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'task for Issue #456',
      expect.objectContaining({
        traceTaskContext: { source: 'issue', issueNumber: 456 },
      }),
      undefined,
    );
  });

  it('should propagate a cancelled task save to the TUI action menu', async () => {
    const result = {
      action: 'save_task',
      task: 'saved task',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    mockSaveTaskFromInteractive.mockResolvedValue({ kind: 'cancelled' } as never);
    let dispatchOutcome: unknown;
    mockRunTui.mockImplementation(async (options: {
      dispatch: (workflowId: string, action: unknown) => Promise<unknown>;
    }) => {
      dispatchOutcome = await options.dispatch('default', result);
      return {
        kind: 'selected',
        workflowId: 'default',
        result: { action: 'cancel', task: '' },
      };
    });

    await executeDefaultAction();

    expect(dispatchOutcome).toMatchObject({ kind: 'cancelled', notice: expect.any(String) });
    expect(mockSaveTaskFromInteractive).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd',
      'saved task',
      'default',
      { allowCancel: true, attachments: result.attachments },
    );
    expect(mockCleanupAttachments).toHaveBeenCalled();
  });

  it('should keep the pasted images alive for a session that stays open', async () => {
    const result = {
      action: 'execute',
      task: 'run it',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    let dispatchOutcome: unknown;
    mockRunTui.mockImplementation(async (options: { dispatch: (id: string, r: unknown) => Promise<unknown> }) => {
      // The session dispatches mid-run and then keeps going.
      dispatchOutcome = await options.dispatch('default', result);
      return { kind: 'selected', workflowId: 'default', result: { action: 'cancel', task: '' } };
    });

    await executeDefaultAction();

    expect(dispatchOutcome).toBeDefined();
    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'run it',
      expect.objectContaining({
        attachments: result.attachments,
        failureMode: 'return',
      }),
      undefined,
    );
    // The store belongs to the open session, so the dispatch leaves it alone.
    expect(mockCleanupAttachments).not.toHaveBeenCalledWith(result);
  });

  it('should keep resident TUI workflow dispatch on the startup CLI overrides', async () => {
    const startupOverrides = { provider: 'mock', model: 'workflow-model' };
    mockResolveAgentOverrides.mockReturnValue(startupOverrides);
    mockRunTui.mockImplementation(async (options: {
      dispatch: (id: string, result: { action: 'execute'; task: string }) => Promise<unknown>;
    }) => {
      await options.dispatch('review', { action: 'execute', task: 'generated instruction' });
      return {
        kind: 'selected',
        workflowId: 'review',
        result: { action: 'cancel', task: '' },
      };
    });

    await executeDefaultAction();

    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'generated instruction',
      expect.objectContaining({ workflow: 'review' }),
      startupOverrides,
    );
  });

  it('should still read the task history only after the mode selector on the classic path', async () => {
    setTerminal(false);

    await executeDefaultAction();

    const selectorOrder = mockSelectInteractiveMode.mock.invocationCallOrder[0];
    const historyOrder = mockLoadTaskHistory.mock.invocationCallOrder[0];
    expect(selectorOrder).toBeDefined();
    expect(historyOrder).toBeDefined();
    expect(selectorOrder!).toBeLessThan(historyOrder!);
  });
});

describe('final classic execution results', () => {
  it.each(['workflow aborted', 'Workflow not found: missing-workflow', undefined])('should reject a final execution failure with reason %s after cleanup', async (reason) => {
    setTerminal(false);
    const result = {
      action: 'execute' as const, task: 'Original proposal',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    const actual = { success: false, ...(reason === undefined ? {} : { reason }) };
    mockInteractiveMode.mockResolvedValueOnce(result);
    operationMocks.execute.mockResolvedValueOnce(actual);
    const exit = expectExit();

    await expect(executeDefaultAction()).rejects.toThrow(describeExecutionResult(actual, 'en').notice);

    expect(mockCleanupAttachments).toHaveBeenCalledExactlyOnceWith(result);
    expect(operationMocks.execute).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd', 'Original proposal', expect.objectContaining({ failureMode: 'return', attachments: result.attachments }), undefined,
    );
    expect(exit).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/successfully/));
  });

  it.each([{ success: true }, { kind: 'cancelled' }] as const)('should display the final result %j and return normally', async (actual) => {
    setTerminal(false);
    const result = { action: 'execute' as const, task: 'Original proposal' };
    mockInteractiveMode.mockResolvedValueOnce(result);
    operationMocks.execute.mockResolvedValueOnce(actual);

    await expect(executeDefaultAction()).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(describeExecutionResult(actual, 'en').notice);
    expect(operationMocks.execute).toHaveBeenCalledTimes(1);
    expect(mockCleanupAttachments).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('should propagate a final execution exception after cleaning up attachments', async () => {
    setTerminal(false);
    const result = {
      action: 'execute' as const, task: 'Original proposal',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    const failure = new Error('provider unavailable');
    mockInteractiveMode.mockResolvedValueOnce(result);
    operationMocks.execute.mockRejectedValueOnce(failure);

    await expect(executeDefaultAction()).rejects.toBe(failure);

    expect(operationMocks.execute).toHaveBeenCalledTimes(1);
    expect(mockCleanupAttachments).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('should propagate a failed final execution from persona mode', async () => {
    setTerminal(false);
    mockSelectInteractiveMode.mockResolvedValueOnce('persona');
    mockGetWorkflowDescription.mockReturnValueOnce({ name: 'default', firstStep: { name: 'coder' } });
    vi.mocked(personaMode).mockResolvedValueOnce({ action: 'execute', task: 'Original proposal' });
    operationMocks.execute.mockResolvedValueOnce({ success: false, reason: 'workflow aborted' });

    await expect(executeDefaultAction()).rejects.toThrow('workflow aborted');
    expect(operationMocks.execute).toHaveBeenCalledTimes(1);
    expect(mockCleanupAttachments).toHaveBeenCalledTimes(1);
  });
});

describe('resident CLI operation results', () => {
  it.each(['workflow aborted', 'workflow not found', 'Workflow not found: missing-workflow'])('should return execution failure reason %s to the classic conversation', async (reason) => {
    setTerminal(false);
    operationMocks.execute.mockResolvedValue({ success: false, reason });
    let outcome: unknown;
    mockInteractiveMode.mockImplementationOnce(async (...args) => {
      outcome = await args[5]!.dispatch!({ action: 'execute', task: 'confirmed instruction' });
      return { action: 'cancel', task: '' };
    });

    await executeDefaultAction();

    expect(outcome).toMatchObject({ kind: 'dispatched', notice: expect.stringContaining(reason) });
    expect(operationMocks.execute).toHaveBeenCalledTimes(1);
  });

  it('should execute a later accepted proposal after saving once in the classic conversation', async () => {
    setTerminal(false);
    mockInteractiveMode.mockImplementationOnce(async (...args) => {
      const options = args[5]!;
      await options.dispatch!({ action: 'save_task', task: 'first instruction' });
      return { action: 'execute', task: 'later accepted proposal' };
    });

    await executeDefaultAction();

    expect(operationMocks.save).toHaveBeenCalledTimes(1);
    expect(operationMocks.execute).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd', 'later accepted proposal', expect.objectContaining({ failureMode: 'return' }), undefined,
    );
  });
  async function dispatch(action: 'save_task' | 'create_issue' | 'execute') {
    let outcome: unknown;
    mockRunTui.mockImplementationOnce(async (options: {
      dispatch: (workflow: string, result: { action: string; task: string }) => Promise<unknown>;
    }) => {
      outcome = await options.dispatch('selected-workflow', { action, task: 'confirmed instruction' });
      return { kind: 'selected', workflowId: 'selected-workflow', result: { action: 'cancel', task: '' } };
    });
    await executeDefaultAction();
    return outcome;
  }

  it('should return the saved task name from the resident dispatcher without saving twice', async () => {
    operationMocks.save.mockResolvedValue({ taskName: 'actual-queued-name', tasksFile: '/test/cwd/.takt/tasks.yaml' });

    const outcome = await dispatch('save_task');

    expect(outcome).toBeDefined();
    expect(JSON.stringify(outcome)).toContain('actual-queued-name');
    expect(operationMocks.save).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd', 'confirmed instruction', 'selected-workflow', { allowCancel: true },
    );
  });

  it.each(['workflow aborted', 'Workflow not found: missing-workflow', undefined])('should return the actual execution failure reason %s from the resident dispatcher', async (reason) => {
    operationMocks.execute.mockResolvedValue({ success: false, ...(reason === undefined ? {} : { reason }) });

    const outcome = await dispatch('execute');

    expect(outcome).toMatchObject({ kind: 'dispatched', notice: expect.stringContaining('failure') });
    const serialized = JSON.stringify(outcome);
    if (reason === undefined) {
      expect(serialized).not.toMatch(/Reason:|Task failed|undefined/);
    } else {
      expect(serialized).toContain(reason);
    }
    expect(mockSelectAndExecuteTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    { success: true, created: { taskName: 'issue-task', tasksFile: '/test/cwd/.takt/tasks.yaml', workflow: 'selected-workflow', issueNumber: 42 } },
    { success: false, failure: { issueCreated: true, issueNumber: 42, taskEnqueued: false, stage: 'task_saving', error: 'disk full' } },
    { success: false, failure: { issueCreated: false, taskEnqueued: false, stage: 'issue_creation', error: 'permission denied' } },
  ] satisfies IssueEnqueueResult[])('should transfer the actual Issue creation result %j without creating twice', async (actual) => {
    operationMocks.issue.mockResolvedValue(actual);

    const outcome = await dispatch('create_issue');

    expect(outcome).toBeDefined();
    const serialized = JSON.stringify(outcome);
    if (actual.success) {
      expect(serialized).toContain('issue-task');
      expect(serialized).toContain('42');
    } else {
      expect(serialized).toContain(actual.failure.error);
      if (actual.failure.issueCreated) expect(serialized).toContain('42');
    }
    expect(operationMocks.issue).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd', 'confirmed instruction', 'selected-workflow', { labels: [] },
    );
  });

  it.each(['save_task', 'create_issue', 'execute'] as const)('should return a %s exception to the open conversation', async (action) => {
    const operation = action === 'save_task' ? operationMocks.save : action === 'create_issue' ? operationMocks.issue : operationMocks.execute;
    operation.mockRejectedValue(new Error('Active task target already exists: login-fix'));

    const outcome = await dispatch(action);

    expect(JSON.stringify(outcome)).toContain('Active task target already exists: login-fix');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
