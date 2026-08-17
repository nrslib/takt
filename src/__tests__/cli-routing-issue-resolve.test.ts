/**
 * Tests for issue resolution in routing module.
 *
 * Verifies that issue references (--issue N or #N positional arg)
 * are resolved before interactive mode and passed to selectAndExecuteTask
 * via selectOptions.issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveAssistantProviderModelFromConfig as realResolveAssistantProviderModelFromConfig } from '../core/config/provider-resolution.js';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

const { mockConfirm } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  mockCheckCliStatus,
  mockFetchIssue,
  mockCommentOnIssue,
  mockGetWorkflowDescription,
  mockResolveAgentOverrides,
  mockResolveAssistantConfigLayers,
} = vi.hoisted(() => ({
  mockCheckCliStatus: vi.fn(),
  mockFetchIssue: vi.fn(),
  mockCommentOnIssue: vi.fn(),
  mockGetWorkflowDescription: vi.fn(() => ({ name: 'default', description: 'test workflow', workflowStructure: '', stepPreviews: [] })),
  mockResolveAgentOverrides: vi.fn(),
  mockResolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
  }),
  parseIssueNumbers: vi.fn(() => []),
  formatIssueAsTask: vi.fn(),
  isIssueReference: vi.fn(),
  resolveIssueTask: vi.fn(),
  formatPrReviewAsTask: vi.fn(),
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
  selectInteractiveMode: vi.fn(() => 'assistant'),
  passthroughMode: vi.fn(),
  quietMode: vi.fn(),
  personaMode: vi.fn(),
  resolveLanguage: vi.fn(() => 'en'),
  selectRun: vi.fn(() => null),
  loadRunSessionContext: vi.fn(),
  listRecentRuns: vi.fn(() => []),
  normalizeTaskHistorySummary: vi.fn((items: unknown[]) => items),
  dispatchConversationAction: vi.fn(async (result: { action: string }, handlers: Record<string, (r: unknown) => unknown>) => {
    return handlers[result.action](result);
  }),
}));

const mockListAllTaskItems = vi.fn();
const mockIsStaleRunningTask = vi.fn();
vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    TaskRunner: vi.fn((projectDir: string) => {
      const runner = new actual.TaskRunner(projectDir);
      runner.listAllTaskItems = mockListAllTaskItems;
      return runner;
    }),
    isStaleRunningTask: (...args: unknown[]) => mockIsStaleRunningTask(...args),
  };
});

vi.mock('../infra/config/index.js', () => ({
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  resolveConfigValue: vi.fn((_: string, key: string) => (key === 'workflow' ? 'default' : false)),
  resolveConfigValues: vi.fn(() => ({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' })),
  loadPersonaSessions: vi.fn(() => ({})),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
  resolveAssistantProviderModel: (projectDir: string, cliOverrides?: { provider?: string; model?: string }) =>
    realResolveAssistantProviderModelFromConfig(
      mockResolveAssistantConfigLayers(projectDir),
      cliOverrides as never,
    ),
}));

vi.mock('../shared/constants.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DEFAULT_WORKFLOW_NAME: 'default',
}));

const mockOpts: Record<string, unknown> = {};

vi.mock('../app/cli/program.js', () => {
  const chainable = {
    opts: vi.fn(() => mockOpts),
    argument: vi.fn().mockReturnThis(),
    action: vi.fn().mockReturnThis(),
  };
  return {
    program: chainable,
  };
});

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/test/cwd', pipelineMode: false })),
}));

vi.mock('../app/cli/helpers.js', () => ({
  resolveAgentOverrides: (...args: unknown[]) => mockResolveAgentOverrides(...args),
  isDirectTask: vi.fn(() => false),
  resolveWorkflowCliOption: vi.fn((opts: Record<string, unknown>) => typeof opts.workflow === 'string' ? opts.workflow : undefined),
}));

import { formatIssueAsTask, parseIssueNumbers } from '../infra/git/index.js';
import { selectAndExecuteTask, determineWorkflow, createIssueAndSaveTask, saveTaskFromInteractive } from '../features/tasks/index.js';
import {
  interactiveMode,
  passthroughMode,
  quietMode,
  personaMode,
  selectInteractiveMode,
} from '../features/interactive/index.js';
import { resolveConfigValues, loadPersonaSessions } from '../infra/config/index.js';
import { isDirectTask } from '../app/cli/helpers.js';
import { executeDefaultAction } from '../app/cli/routing.js';
import { saveTaskFile } from '../features/tasks/add/index.js';
import { info, warn, error } from '../shared/ui/index.js';
import { confirm } from '../shared/prompt/index.js';
import type { Issue } from '../infra/git/index.js';

const mockFormatIssueAsTask = vi.mocked(formatIssueAsTask);
const mockParseIssueNumbers = vi.mocked(parseIssueNumbers);
const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);
const mockDetermineWorkflow = vi.mocked(determineWorkflow);
const mockCreateIssueAndSaveTask = vi.mocked(createIssueAndSaveTask);
const mockSaveTaskFromInteractive = vi.mocked(saveTaskFromInteractive);
const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPassthroughMode = vi.mocked(passthroughMode);
const mockQuietMode = vi.mocked(quietMode);
const mockPersonaMode = vi.mocked(personaMode);
const mockSelectInteractiveMode = vi.mocked(selectInteractiveMode);
const mockLoadPersonaSessions = vi.mocked(loadPersonaSessions);
const mockResolveConfigValues = vi.mocked(resolveConfigValues);
const mockIsDirectTask = vi.mocked(isDirectTask);
const mockInfo = vi.mocked(info);
const mockWarn = vi.mocked(warn);
const mockError = vi.mocked(error);
const mockConfirmFn = vi.mocked(confirm);
const mockTaskRunnerListAllTaskItems = vi.mocked(mockListAllTaskItems);

function createMockIssue(number: number): Issue {
  return {
    number,
    title: `Issue #${number}`,
    body: `Body of issue #${number}`,
    labels: [],
    comments: [],
  };
}

type SavedTaskResult = NonNullable<Awaited<ReturnType<typeof saveTaskFromInteractive>>>;

function createSavedTaskResult(overrides: {
  taskContent: string;
  sourceIssueNumber?: number;
}): SavedTaskResult {
  return {
    taskName: 'saved-task',
    tasksFile: '/test/cwd/.takt/tasks.yaml',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset opts
  for (const key of Object.keys(mockOpts)) {
    delete mockOpts[key];
  }
  // Default setup
  mockDetermineWorkflow.mockResolvedValue('default');
  mockGetWorkflowDescription.mockReturnValue({ name: 'default', description: 'test workflow', workflowStructure: '', stepPreviews: [] });
  mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'summarized task' });
  mockPassthroughMode.mockResolvedValue({ action: 'execute', task: 'passthrough task' });
  mockQuietMode.mockResolvedValue({ action: 'execute', task: 'summarized task' });
  mockPersonaMode.mockResolvedValue({ action: 'execute', task: 'summarized task' });
  mockSelectInteractiveMode.mockResolvedValue('assistant');
  mockIsDirectTask.mockReturnValue(false);
  mockResolveAgentOverrides.mockReturnValue(undefined);
  mockParseIssueNumbers.mockReturnValue([]);
  mockTaskRunnerListAllTaskItems.mockReturnValue([]);
  mockIsStaleRunningTask.mockReturnValue(false);
  mockResolveAssistantConfigLayers.mockReturnValue({ local: {}, global: {} });
  mockCheckCliStatus.mockReturnValue({ available: true });
  mockConfirmFn.mockResolvedValue(true);
  mockCommentOnIssue.mockReturnValue({ success: true });
});

describe('Issue resolution in routing', () => {
  it('should show error and exit when --auto-pr/--draft are used outside pipeline mode', async () => {
    mockOpts.autoPr = true;
    mockOpts.draft = true;

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockError).toHaveBeenCalledWith('--auto-pr/--draft are supported only in --pipeline mode');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();

    mockExit.mockRestore();
  });

  it('should show error and exit when only --auto-pr is used outside pipeline mode', async () => {
    mockOpts.autoPr = true;

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockError).toHaveBeenCalledWith('--auto-pr/--draft are supported only in --pipeline mode');
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });

  it('should show error and exit when only --draft is used outside pipeline mode', async () => {
    mockOpts.draft = true;

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(executeDefaultAction()).rejects.toThrow('process.exit called');

    expect(mockError).toHaveBeenCalledWith('--auto-pr/--draft are supported only in --pipeline mode');
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });


  describe('--issue option', () => {
    it('should pass --workflow to determineWorkflow and selectAndExecuteTask', async () => {
      mockOpts.workflow = 'migration-workflow';
      mockDetermineWorkflow.mockResolvedValue('migration-workflow');

      await executeDefaultAction();

      expect(mockDetermineWorkflow).toHaveBeenCalledWith('/test/cwd', 'migration-workflow');
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          workflow: 'migration-workflow',
          interactiveUserInput: true,
          skipTaskList: true,
        }),
        undefined,
      );
    });

    it('should resolve issue and pass to interactive mode when --issue is specified', async () => {
      // Given
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');

      // When
      await executeDefaultAction();

      // Then: issue should be fetched
      expect(mockFetchIssue).toHaveBeenCalledWith(131, undefined);

      // Then: interactive mode should receive the formatted issue as initial input
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { sourceContext: '## Issue #131: Issue #131' },
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );

      // Then: selectAndExecuteTask should receive issue metadata for trace discovery
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          traceTaskContext: {
            source: 'issue',
            issueNumber: 131,
          },
        }),
        undefined,
      );
    });

    it('should exit with error when gh CLI is unavailable for --issue', async () => {
      // Given
      mockOpts.issue = 131;
      mockCheckCliStatus.mockReturnValue({
        available: false,
        error: 'gh CLI is not installed',
      });

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // When / Then
      await expect(executeDefaultAction()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockInteractiveMode).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });

    it('should save issue number when interactive save_task is selected', async () => {
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved issue task' });

      await executeDefaultAction();

      expect(mockSaveTaskFromInteractive).toHaveBeenCalledWith(
        '/test/cwd',
        'Saved issue task',
        'default',
        expect.objectContaining({
          issue: 131,
        }),
      );
    });

    it('should ask after saving and post the confirmed task content to the source issue', async () => {
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      const taskContent = 'Confirmed task instructions\nwith full details';
      const savedTaskContent = 'Saved task instructions\nwith persisted details';
      const order: string[] = [];
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: taskContent });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options).toEqual(expect.objectContaining({ issue: 131 }));
        order.push('save');
        return createSavedTaskResult({
          taskContent: savedTaskContent,
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });
      mockConfirmFn.mockImplementation(async (message: string, defaultYes: boolean) => {
        order.push('confirm');
        expect(message).toBe('Issue #131 にタスク指示書をコメントしますか？');
        expect(defaultYes).toBe(true);
        return true;
      });
      mockCommentOnIssue.mockImplementation(() => {
        order.push('comment');
        return { success: true };
      });

      await executeDefaultAction();

      expect(mockCommentOnIssue).toHaveBeenCalledWith(131, savedTaskContent, '/test/cwd');
      expect(order).toEqual(['save', 'confirm', 'comment']);
    });

    it('should keep the saved task and skip the comment when confirmation is declined', async () => {
      mockOpts.issue = 131;
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(createMockIssue(131));
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved issue task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options).toEqual(expect.objectContaining({ issue: 131 }));
        return createSavedTaskResult({
          taskContent: 'Saved issue task',
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });
      mockConfirmFn.mockResolvedValue(false);

      await executeDefaultAction();

      expect(mockSaveTaskFromInteractive).toHaveBeenCalledTimes(1);
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });

    it('should preserve the saved task and warn once when comment posting fails', async () => {
      mockOpts.issue = 131;
      const saveRoot = mkdtempSync(join(tmpdir(), 'takt-routing-comment-failure-'));
      let savedTasksFile: string | undefined;
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(createMockIssue(131));
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved issue task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options).toEqual(expect.objectContaining({ issue: 131 }));
        const created = await saveTaskFile(saveRoot, _task, {
          workflow: _workflow,
          issue: options?.issue,
        });
        savedTasksFile = created.tasksFile;
        const savedData = parseYaml(readFileSync(created.tasksFile, 'utf-8')) as {
          tasks: Array<{ task_dir?: string }>;
        };
        const savedRecord = savedData.tasks[0];
        if (savedRecord?.task_dir === undefined) {
          throw new Error('Saved task directory is missing');
        }
        return {
          ...created,
          taskContent: readFileSync(join(saveRoot, savedRecord.task_dir, 'order.md'), 'utf-8'),
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        };
      });
      mockCommentOnIssue.mockReturnValue({ success: false, error: 'Permission denied' });

      try {
        await executeDefaultAction();

        expect(savedTasksFile).toBeDefined();
        if (savedTasksFile === undefined) {
          throw new Error('Task file was not saved');
        }
        const savedData = parseYaml(readFileSync(savedTasksFile, 'utf-8')) as {
          tasks: Array<{ issue?: number; task_dir?: string }>;
        };
        const savedRecord = savedData.tasks[0];
        expect(savedRecord?.issue).toBe(131);
        expect(savedRecord?.task_dir).toBeTypeOf('string');
        if (savedRecord?.task_dir === undefined) {
          throw new Error('Saved task directory is missing');
        }
        expect(readFileSync(join(saveRoot, savedRecord.task_dir, 'order.md'), 'utf-8')).toBe('Saved issue task');
        expect(mockSaveTaskFromInteractive).toHaveBeenCalledTimes(1);
        expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('#131'));
        expect(mockWarn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('Permission denied'));
      } finally {
        rmSync(saveRoot, { recursive: true, force: true });
      }
    });

    it('should convert an unexpected comment error into one warning without retrying', async () => {
      mockOpts.issue = 131;
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(createMockIssue(131));
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved issue task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options).toEqual(expect.objectContaining({ issue: 131 }));
        return createSavedTaskResult({
          taskContent: 'Saved issue task',
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });
      mockCommentOnIssue.mockImplementation(() => {
        throw new Error('network unavailable');
      });

      await expect(executeDefaultAction()).resolves.toBeUndefined();

      expect(mockSaveTaskFromInteractive).toHaveBeenCalledTimes(1);
      expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('#131'));
      expect(mockWarn.mock.calls[0]?.[0]).toEqual(expect.stringContaining('network unavailable'));
    });
  });

  describe('#N positional argument', () => {
    it('should resolve issue reference and pass to interactive mode', async () => {
      // Given
      const issue131 = createMockIssue(131);
      mockIsDirectTask.mockReturnValue(true);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockParseIssueNumbers.mockReturnValue([131]);

      // When
      await executeDefaultAction('#131');

      // Then: interactive mode should be entered with formatted issue
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { sourceContext: '## Issue #131: Issue #131' },
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );

      // Then: selectAndExecuteTask should receive parsed issue metadata for trace discovery
      expect(mockSelectAndExecuteTask).toHaveBeenCalledWith(
        '/test/cwd',
        'summarized task',
        expect.objectContaining({
          traceTaskContext: {
            source: 'issue',
            issueNumber: 131,
          },
        }),
        undefined,
      );
    });

    it('should save and comment the saved task for a single parsed issue reference', async () => {
      const issue131 = createMockIssue(131);
      const savedTaskContent = 'Saved task instructions from positional issue';
      mockIsDirectTask.mockReturnValue(true);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockParseIssueNumbers.mockReturnValue([131]);
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved issue task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options).toEqual(expect.objectContaining({ issue: 131 }));
        return createSavedTaskResult({
          taskContent: savedTaskContent,
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });

      await executeDefaultAction('#131');

      expect(mockSaveTaskFromInteractive).toHaveBeenCalledWith(
        '/test/cwd',
        'Saved issue task',
        'default',
        expect.objectContaining({
          issue: 131,
        }),
      );
      expect(mockConfirmFn).toHaveBeenCalledWith('Issue #131 にタスク指示書をコメントしますか？', true);
      expect(mockCommentOnIssue).toHaveBeenCalledWith(131, savedTaskContent, '/test/cwd');
    });

    it('should not post a comment when multiple issue references are provided', async () => {
      mockIsDirectTask.mockReturnValue(true);
      mockParseIssueNumbers.mockReturnValue([131, 132]);
      mockFetchIssue.mockImplementation((issueNumber: number) => createMockIssue(issueNumber));
      mockFormatIssueAsTask.mockImplementation((issue: Issue) => `## Issue #${issue.number}`);
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Saved multi-issue task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options?.issue).toBeUndefined();
        return createSavedTaskResult({
          taskContent: 'Saved multi-issue task',
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });

      await executeDefaultAction('#131 #132');

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe('non-issue input', () => {
    it('should pass regular text input to interactive mode without issues', async () => {
      // When
      await executeDefaultAction('refactor the code');

      // Then: interactive mode should receive the original text
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'refactor the code' },
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );

      // Then: no issue fetching should occur
      expect(mockFetchIssue).not.toHaveBeenCalled();

      // Then: selectAndExecuteTask should be called
      expect(mockSelectAndExecuteTask).toHaveBeenCalledTimes(1);
    });

    it('should pass regular text input as a direct task to quiet mode', async () => {
      mockSelectInteractiveMode.mockResolvedValueOnce('quiet');

      await executeDefaultAction('refactor the code');

      expect(mockQuietMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'refactor the code' },
        expect.anything(),
      );
      expect(mockInteractiveMode).not.toHaveBeenCalled();
    });

    it('should pass regular text input as a direct task to persona mode', async () => {
      mockSelectInteractiveMode.mockResolvedValueOnce('persona');
      mockGetWorkflowDescription.mockReturnValueOnce({
        name: 'default',
        description: 'test workflow',
        workflowStructure: '',
        stepPreviews: [],
        firstStep: {
          personaContent: 'You are a coder.',
          personaDisplayName: 'Coder',
          allowedTools: ['Read'],
        },
      });

      await executeDefaultAction('refactor the code');

      expect(mockPersonaMode).toHaveBeenCalledWith(
        '/test/cwd',
        expect.anything(),
        { userMessage: 'refactor the code' },
        expect.anything(),
      );
      expect(mockInteractiveMode).not.toHaveBeenCalled();
    });

    it('should pass regular text input to passthrough mode as the raw task', async () => {
      mockSelectInteractiveMode.mockResolvedValueOnce('passthrough');

      await executeDefaultAction('refactor the code');

      expect(mockPassthroughMode).toHaveBeenCalledWith('en', 'refactor the code');
      expect(mockInteractiveMode).not.toHaveBeenCalled();
    });

    it('should enter interactive mode with no input when no args provided', async () => {
      // When
      await executeDefaultAction();

      // Then: interactive mode should be entered with undefined input
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );

      // Then: no issue fetching should occur
      expect(mockFetchIssue).not.toHaveBeenCalled();
    });

    it('should save a non-issue task without asking for an issue comment', async () => {
      mockInteractiveMode.mockResolvedValue({ action: 'save_task', task: 'Standalone task' });
      mockSaveTaskFromInteractive.mockImplementation(async (_cwd, _task, _workflow, options) => {
        expect(options?.issue).toBeUndefined();
        return createSavedTaskResult({
          taskContent: 'Standalone task',
          ...(options?.issue !== undefined ? { sourceIssueNumber: options.issue } : {}),
        });
      });

      await executeDefaultAction('standalone input');

      expect(mockSaveTaskFromInteractive).toHaveBeenCalledTimes(1);
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });

    it('should not ask for or post an issue comment for execute', async () => {
      mockOpts.issue = 131;
      mockFetchIssue.mockReturnValue(createMockIssue(131));
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'execute', task: 'Execute task' });

      await executeDefaultAction();

      expect(mockSelectAndExecuteTask).toHaveBeenCalledTimes(1);
      expect(mockSaveTaskFromInteractive).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe('issue source context routing by mode', () => {
    it('should pass issue context only to quiet mode', async () => {
      mockOpts.issue = 131;
      mockSelectInteractiveMode.mockResolvedValueOnce('quiet');
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');

      await executeDefaultAction();

      expect(mockQuietMode).toHaveBeenCalledWith(
        '/test/cwd',
        { sourceContext: '## Issue #131: Issue #131' },
        expect.anything(),
      );
      expect(mockInteractiveMode).not.toHaveBeenCalled();
    });

    it('should pass issue context only to persona mode', async () => {
      mockOpts.issue = 131;
      mockSelectInteractiveMode.mockResolvedValueOnce('persona');
      mockGetWorkflowDescription.mockReturnValueOnce({
        name: 'default',
        description: 'test workflow',
        workflowStructure: '',
        stepPreviews: [],
        firstStep: {
          personaContent: 'You are a coder.',
          personaDisplayName: 'Coder',
          allowedTools: ['Read'],
        },
      });
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');

      await executeDefaultAction();

      expect(mockPersonaMode).toHaveBeenCalledWith(
        '/test/cwd',
        expect.anything(),
        { sourceContext: '## Issue #131: Issue #131' },
        expect.anything(),
      );
      expect(mockInteractiveMode).not.toHaveBeenCalled();
    });

    it('should pass complete issue context and grill-me mode to interactive mode', async () => {
      mockOpts.issue = 131;
      mockSelectInteractiveMode.mockResolvedValueOnce('grill-me');
      const sourceContext = [
        'Issue body',
        '**first-author**: first comment',
        '**task-author**: past task instructions',
        '**latest-author**: latest comment',
      ].join('\n');
      const issue131 = {
        ...createMockIssue(131),
        body: 'Issue body',
        comments: [
          { author: 'first-author', body: 'first comment' },
          { author: 'task-author', body: 'past task instructions' },
          { author: 'latest-author', body: 'latest comment' },
        ],
      };
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue(sourceContext);

      await executeDefaultAction();

      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { sourceContext },
        expect.anything(),
        undefined,
        undefined,
        { assistantMode: 'grill-me' },
      );
    });

    it('should not offer passthrough mode when only issue source context is available', async () => {
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131: Issue #131');

      await executeDefaultAction();

      expect(mockSelectInteractiveMode).toHaveBeenCalledWith(
        'en',
        undefined,
        ['assistant', 'grill-me', 'persona', 'quiet'],
      );
      expect(mockPassthroughMode).not.toHaveBeenCalled();
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { sourceContext: '## Issue #131: Issue #131' },
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('task history injection', () => {
    it('should include failed/completed/interrupted tasks in workflow context for interactive mode', async () => {
      const failedTask = {
        kind: 'failed' as const,
        name: 'failed-task',
        createdAt: '2026-02-17T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'failed',
        worktreePath: '/tmp/task/failed',
        branch: 'takt/failed',
        startedAt: '2026-02-17T00:00:00.000Z',
        completedAt: '2026-02-17T00:10:00.000Z',
        failure: { error: 'syntax error' },
      };
      const completedTask = {
        kind: 'completed' as const,
        name: 'completed-task',
        createdAt: '2026-02-16T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'done',
        worktreePath: '/tmp/task/completed',
        branch: 'takt/completed',
        startedAt: '2026-02-16T00:00:00.000Z',
        completedAt: '2026-02-16T00:07:00.000Z',
      };
      const runningTask = {
        kind: 'running' as const,
        name: 'running-task',
        createdAt: '2026-02-15T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'running',
        worktreePath: '/tmp/task/interrupted',
        ownerPid: 555,
        startedAt: '2026-02-15T00:00:00.000Z',
      };
      mockTaskRunnerListAllTaskItems.mockReturnValue([failedTask, completedTask, runningTask]);
      mockIsStaleRunningTask.mockReturnValue(true);

      // When
      await executeDefaultAction('add feature');

      // Then
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'add feature' },
        expect.objectContaining({
          taskHistory: expect.arrayContaining([
            expect.objectContaining({
              worktreeId: '/tmp/task/failed',
              status: 'failed',
              finalResult: 'failed',
              logKey: 'takt/failed',
            }),
            expect.objectContaining({
              worktreeId: '/tmp/task/completed',
              status: 'completed',
              finalResult: 'completed',
              logKey: 'takt/completed',
            }),
            expect.objectContaining({
              worktreeId: '/tmp/task/interrupted',
              status: 'interrupted',
              finalResult: 'interrupted',
              logKey: '/tmp/task/interrupted',
            }),
          ]),
        }),
        undefined,
        undefined,
        undefined,
      );
    });

    it('should treat running tasks with no ownerPid as interrupted', async () => {
      const runningTaskWithoutPid = {
        kind: 'running' as const,
        name: 'running-task-no-owner',
        createdAt: '2026-02-15T00:00:00.000Z',
        filePath: '/project/.takt/tasks.yaml',
        content: 'running',
        worktreePath: '/tmp/task/running-no-owner',
        branch: 'takt/running-no-owner',
        startedAt: '2026-02-15T00:00:00.000Z',
      };
      mockTaskRunnerListAllTaskItems.mockReturnValue([runningTaskWithoutPid]);
      mockIsStaleRunningTask.mockReturnValue(true);

      await executeDefaultAction('recover interrupted');

      expect(mockIsStaleRunningTask).toHaveBeenCalledWith(undefined);
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'recover interrupted' },
        expect.objectContaining({
          taskHistory: expect.arrayContaining([
            expect.objectContaining({
              worktreeId: '/tmp/task/running-no-owner',
              status: 'interrupted',
              finalResult: 'interrupted',
              logKey: 'takt/running-no-owner',
            }),
          ]),
        }),
        undefined,
        undefined,
        undefined,
      );
    });

    it('should continue interactive mode when task list retrieval fails', async () => {
      mockTaskRunnerListAllTaskItems.mockImplementation(() => {
        throw new Error('list failed');
      });

      // When
      await executeDefaultAction('fix issue');

      // Then
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'fix issue' },
        expect.objectContaining({ taskHistory: [] }),
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass empty taskHistory when task list is empty', async () => {
      mockTaskRunnerListAllTaskItems.mockReturnValue([]);

      await executeDefaultAction('verify history');

      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        { userMessage: 'verify history' },
        expect.objectContaining({ taskHistory: [] }),
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('interactive mode cancel', () => {
    it('should not call selectAndExecuteTask when interactive mode is cancelled', async () => {
      // Given
      mockOpts.issue = 131;
      const issue131 = createMockIssue(131);
      mockCheckCliStatus.mockReturnValue({ available: true });
      mockFetchIssue.mockReturnValue(issue131);
      mockFormatIssueAsTask.mockReturnValue('## Issue #131');
      mockInteractiveMode.mockResolvedValue({ action: 'cancel', task: '' });

      // When
      await executeDefaultAction();

      // Then
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    });
  });

  describe('create_issue action', () => {
    it('should delegate to createIssueAndSaveTask with confirmAtEndMessage', async () => {
      // Given
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature request' });

      // When
      await executeDefaultAction();

      // Then: issue is created first
      expect(mockCreateIssueAndSaveTask).toHaveBeenCalledWith(
        '/test/cwd',
        'New feature request',
        'default',
        { confirmAtEndMessage: 'Add this issue to tasks?', labels: [] },
      );
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });

    it('should not call selectAndExecuteTask when create_issue action is chosen', async () => {
      // Given
      mockInteractiveMode.mockResolvedValue({ action: 'create_issue', task: 'New feature request' });

      // When
      await executeDefaultAction();

      // Then: selectAndExecuteTask should NOT be called
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    });
  });

  describe('--continue option', () => {
    it('should resume the Grill Me session independently from the standard assistant', async () => {
      mockOpts.continue = true;
      mockSelectInteractiveMode.mockResolvedValue('grill-me');
      mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' });
      mockResolveAssistantConfigLayers.mockReturnValue({ local: { provider: 'claude' }, global: {} });
      mockLoadPersonaSessions.mockReturnValue({
        interactive: 'assistant-session',
        'grill-me-interactive': 'grill-session',
      });

      await executeDefaultAction();

      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'grill-session',
        undefined,
        { assistantMode: 'grill-me' },
      );
    });

    it('should load saved session and pass to interactiveMode when --continue is specified', async () => {
      // Given
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' });
      mockResolveAssistantConfigLayers.mockReturnValue({ local: { provider: 'claude' }, global: {} });
      mockLoadPersonaSessions.mockReturnValue({ interactive: 'saved-session-123' });

      // When
      await executeDefaultAction();

      // Then: loadPersonaSessions should be called with provider
      expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/test/cwd', 'claude');

      // Then: interactiveMode should receive the saved session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'saved-session-123',
        undefined,
        undefined,
      );
    });

    it('should load assistant-scoped session when takt_providers.assistant is configured', async () => {
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
        interactivePreviewSteps: 3,
        provider: 'claude',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'claude',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'assistant-model',
            },
          },
        },
        global: {},
      });
      mockLoadPersonaSessions.mockReturnValue({
        'interactive:codex': 'saved-session-codex',
        interactive: 'saved-session-legacy',
      });

      await executeDefaultAction();

      expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/test/cwd', 'codex');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'saved-session-codex',
        undefined,
        undefined,
      );
    });

    it('should prioritize CLI provider/model over takt_providers.assistant in --continue and interactiveMode', async () => {
      mockOpts.continue = true;
      mockResolveAgentOverrides.mockReturnValue({ provider: 'opencode', model: 'cli-model' });
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
        interactivePreviewSteps: 3,
        provider: 'claude',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'claude',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'assistant-model',
            },
          },
        },
        global: {},
      });
      mockLoadPersonaSessions.mockReturnValue({
        'interactive:opencode': 'saved-session-opencode',
        'interactive:codex': 'saved-session-codex',
      });

      await executeDefaultAction();

      expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/test/cwd', 'opencode');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'saved-session-opencode',
        undefined,
        { provider: 'opencode', model: 'cli-model' },
      );
    });

    it('should use local assistant config for --continue when local config exists', async () => {
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({
        language: 'en',
        interactivePreviewSteps: 3,
        provider: 'mock',
        model: 'global-top-level-model',
      });
      mockResolveAssistantConfigLayers.mockReturnValue({
        local: {
          provider: 'opencode',
          model: 'local-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'codex',
              model: 'local-assistant-model',
            },
          },
        },
        global: {
          provider: 'claude',
          model: 'global-top-level-model',
          taktProviders: {
            assistant: {
              provider: 'cursor',
              model: 'global-assistant-model',
            },
          },
        },
      });
      mockLoadPersonaSessions.mockReturnValue({
        'interactive:codex': 'saved-session-codex',
      });

      await executeDefaultAction();

      expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/test/cwd');
      expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/test/cwd', 'codex');
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        'saved-session-codex',
        undefined,
        undefined,
      );
    });

    it('should show message and start new session when --continue has no saved session', async () => {
      // Given
      mockOpts.continue = true;
      mockResolveConfigValues.mockReturnValue({ language: 'en', interactivePreviewSteps: 3, provider: 'claude' });
      mockResolveAssistantConfigLayers.mockReturnValue({ local: { provider: 'claude' }, global: {} });
      mockLoadPersonaSessions.mockReturnValue({});

      // When
      await executeDefaultAction();

      // Then: info message about no session
      expect(mockInfo).toHaveBeenCalledWith(
        'No previous assistant session found. Starting a new session.',
      );

      // Then: interactiveMode should be called with undefined session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );
    });

    it('should not load persona sessions when --continue is not specified', async () => {
      // When
      await executeDefaultAction();

      // Then: loadPersonaSessions should NOT be called
      expect(mockLoadPersonaSessions).not.toHaveBeenCalled();

      // Then: interactiveMode should be called with undefined session ID
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('default assistant mode (no --continue)', () => {
    it('should start new session without loading saved sessions', async () => {
      await executeDefaultAction();

      expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
      expect(mockInteractiveMode).toHaveBeenCalledWith(
        '/test/cwd',
        undefined,
        expect.anything(),
        undefined,
        undefined,
        undefined,
      );
    });
  });
});
