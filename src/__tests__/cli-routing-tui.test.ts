/**
 * Tests for how the default CLI action chooses between the Ink TUI and the
 * classic readline conversation.
 *
 * Contract: a TTY always gets the TUI, `--tui`
 * demands a terminal, and without a terminal the classic path always runs so
 * piped input keeps working.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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
  selectAndExecuteTask: vi.fn(),
  determineWorkflow: vi.fn(),
  saveTaskFromInteractive: vi.fn(),
  createIssueAndSaveTask: vi.fn(),
  promptLabelSelection: vi.fn().mockResolvedValue([]),
}));

vi.mock('../features/pipeline/index.js', () => ({
  executePipeline: vi.fn(),
}));

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
  selectInteractiveMode: vi.fn(),
  passthroughMode: vi.fn(),
  quietMode: vi.fn(),
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

import { determineWorkflow, saveTaskFromInteractive, selectAndExecuteTask } from '../features/tasks/index.js';
import { cleanupInteractiveResultAttachments } from '../features/interactive/imageAttachments.js';
import { interactiveMode, selectInteractiveMode } from '../features/interactive/index.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { error as logError } from '../shared/ui/index.js';

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
  mockRunTui.mockResolvedValue({ workflowId: 'default', result: { action: 'execute', task: 'tui task' } });
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

  it('should fail fast when --tui is forced without a terminal', async () => {
    mockOpts.tui = true;
    setTerminal(false);
    const exit = expectExit();

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockLogError).toHaveBeenCalledWith(
      '--tui requires an interactive terminal. Run takt from a TTY or drop --tui.',
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
    mockRunTui.mockResolvedValue({ workflowId: 'default', result });

    await executeDefaultAction();

    // Saved against the workflow the TUI settled on, with the pasted images.
    expect(mockSaveTaskFromInteractive).toHaveBeenCalledExactlyOnceWith(
      '/test/cwd',
      'saved task',
      'default',
      { attachments: result.attachments },
    );
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    // The temp files are released once the task owns them.
    expect(mockCleanupAttachments).toHaveBeenCalledWith(result);
  });

  it('should keep the pasted images alive for a session that stays open', async () => {
    const result = {
      action: 'execute',
      task: 'run it',
      attachments: [{ placeholder: '[Image #1]', tempPath: '/tmp/i.png', fileName: 'i.png' }],
    };
    let dispatchOutcome: unknown;
    mockRunTui.mockImplementation(async (options: { dispatch: (id: string, r: unknown) => Promise<void> }) => {
      // The session dispatches mid-run and then keeps going.
      dispatchOutcome = await options.dispatch('default', result);
      return { kind: 'selected', workflowId: 'default', result: { action: 'cancel', task: '' } };
    });

    await executeDefaultAction();

    expect(dispatchOutcome).toBeUndefined();
    expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
      '/test/cwd',
      'run it',
      expect.objectContaining({ attachments: result.attachments }),
      undefined,
    );
    // The store belongs to the open session, so the dispatch leaves it alone.
    expect(mockCleanupAttachments).not.toHaveBeenCalledWith(result);
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
