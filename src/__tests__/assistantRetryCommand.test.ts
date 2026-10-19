vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkTaskNameProvider: vi.fn(async () => undefined), checkQueuedTaskProviders: vi.fn(async () => undefined), terminalProviderConfirmation: vi.fn(() => undefined) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import type { FailedTaskRetryPreparation } from '../features/tasks/taskRetryPreparation.js';
import type { AssistantRetryCommandOptions } from '../features/interactive/assistantRetryCommand.js';
import { buildTaskRetryStartOptions, InvalidTaskRetryResumeWithoutRestartError } from '../features/tasks/list/taskRetryStartSelection.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getLabel } from '../shared/i18n/index.js';
import { sanitizeTerminalText } from '../shared/utils/text.js';
import type { WorkflowRestartPoint, WorkflowResumePoint } from '../core/models/index.js';

const mocks = vi.hoisted(() => ({
  callAIWithRetry: vi.fn(),
  hasInteractiveTerminal: vi.fn(() => true),
  useTty: vi.fn(() => true),
  listAllTaskItems: vi.fn<() => TaskListItem[]>(() => []),
  requeueExceededTask: vi.fn(),
  requeueTask: vi.fn(),
  loadWorkflowByIdentifier: vi.fn(),
  assertReusableWorktreePath: vi.fn(),
  resolveWorkflowCallTarget: vi.fn(),
  prepareFailedTaskRetry: vi.fn(),
  buildFailedTaskRetryStartContext: vi.fn(),
  resolveFailedTaskRetryStart: vi.fn(),
  persistFailedTaskRetry: vi.fn(),
  confirmWithCancel: vi.fn<typeof import('../shared/prompt/index.js').confirmWithCancel>(),
  selectOption: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  info: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    TaskRunner: class {
      listAllTaskItems(): TaskListItem[] {
        return mocks.listAllTaskItems();
      }

      requeueExceededTask(taskName: string): void {
        mocks.requeueExceededTask(taskName);
      }

      requeueTask(...args: unknown[]): string {
        return mocks.requeueTask(...args);
      }
    },
  };
});

vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: (...args: unknown[]) => mocks.callAIWithRetry(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  loadWorkflowByIdentifier: (...args: unknown[]) => mocks.loadWorkflowByIdentifier(...args),
  resolveWorkflowCallTarget: (...args: unknown[]) => mocks.resolveWorkflowCallTarget(...args),
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: (...args: unknown[]) => mocks.assertReusableWorktreePath(...args),
  toReusedTaskInfo: (task: unknown) => task,
  resolveReusedWorktreeExecution: (projectDir: string, task: { worktreePath?: string }) => {
    if (task.worktreePath === undefined) return undefined;
    mocks.assertReusableWorktreePath(projectDir, task.worktreePath);
    return { worktreePath: task.worktreePath, execCwd: task.worktreePath, isWorktree: true };
  },
}));

vi.mock('../features/tasks/taskRetryPreparation.js', () => ({
  prepareFailedTaskRetry: (...args: unknown[]) => mocks.prepareFailedTaskRetry(...args),
  buildFailedTaskRetryStartContext: (...args: unknown[]) => mocks.buildFailedTaskRetryStartContext(...args),
  resolveFailedTaskRetryStart: (...args: unknown[]) => mocks.resolveFailedTaskRetryStart(...args),
}));

vi.mock('../features/tasks/taskRetryPersistence.js', () => ({
  appendRetryNote: (existing: string | undefined, additional: string) =>
    existing ? `${existing}\n\n${additional}` : additional,
  persistFailedTaskRetry: async (...args: unknown[]) => mocks.persistFailedTaskRetry(...args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  hasInteractiveTerminal: () => mocks.hasInteractiveTerminal(),
}));

vi.mock('../shared/prompt/tty.js', () => ({
  resolveTtyPolicy: () => ({ useTty: mocks.useTty(), forceTouchTty: false }),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  confirm: vi.fn().mockResolvedValue(false),
  confirmWithCancel: mocks.confirmWithCancel,
  selectOption: (...args: unknown[]) => mocks.selectOption(...args),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/ui/index.js')>()),
  info: (...args: unknown[]) => mocks.info(...args),
  blankLine: (...args: unknown[]) => mocks.blankLine(...args),
}));

import { runAssistantRetryCommand } from '../features/interactive/assistantRetryCommand.js';

const task: TaskListItem = {
  kind: 'failed',
  name: 'fix-quint-diagnostics',
  createdAt: '2026-09-28T00:00:00.000Z',
  filePath: '/repo/.takt/tasks.yaml',
  content: 'Fix the failed diagnostics.',
  summary: 'Fix diagnostics',
  taskDir: '.takt/tasks/fix-quint-diagnostics',
  runSlug: 'failed-run',
  worktreePath: '/repo/.takt/worktrees/fix-quint-diagnostics',
  data: {
    task: 'Fix the failed diagnostics.',
    workflow: 'development',
    retry_note: 'Old diagnostic note',
  },
  failure: {
    step: 'implement',
    error: 'Type check failed',
    last_message: 'The build failed.',
  },
};

const exceededTask: TaskListItem = {
  ...task,
  kind: 'exceeded',
  name: 'long-running-task',
  summary: 'Resume the stopped task',
  data: {
    task: 'Continue the long task.',
    workflow: 'development',
    start_step: 'review',
    exceeded_current_iteration: 8,
  },
  failure: undefined,
  exceededCurrentIteration: 8,
};

const exceededWorkflow = attachWorkflowOpaqueRef({
  name: 'development', initialStep: 'implement', maxSteps: 10,
  steps: ['implement', 'review'].map((name) => ({ name, personaDisplayName: name, instruction: name })),
}, 'project:development');

const exceededTaskWithoutStart: TaskListItem = {
  ...exceededTask,
  data: { ...exceededTask.data!, start_step: undefined, retry_note: 'Existing note' },
};

const exceededResumePoint: WorkflowResumePoint = {
  version: 2,
  stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'review', kind: 'agent', occurrence: 1 }],
  iteration: 8, elapsed_ms: 1000, workflow_call_invocations: {}, workflow_step_participations: {},
};

const implementRestartPoint: WorkflowRestartPoint = {
  stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'implement', kind: 'agent' }],
};

const preparation: FailedTaskRetryPreparation = {
  worktreePath: task.worktreePath!,
  freshStart: false,
  interactionCwd: task.worktreePath!,
  runsBaseDir: task.worktreePath!,
  failure: task.failure!,
  failedStep: 'implement',
  matchedRunSlug: 'failed-run',
  runMeta: null,
  previousWorkflow: 'development',
  previousOrderContent: '# Original order\n\nFix diagnostics.',
  resumePoint: undefined,
};

const options: AssistantRetryCommandOptions = {
  cwd: '/repo',
  lang: 'en',
  command: 'retry',
  inlineText: '',
  history: [
    { role: 'user', content: 'Fix the diagnostic parser.' },
    { role: 'assistant', content: 'The failed task is fix-quint-diagnostics.' },
  ],
  sessionContext: {
    provider: {} as AssistantRetryCommandOptions['sessionContext']['provider'],
    providerType: 'mock',
    model: undefined,
    lang: 'en',
    personaName: 'assistant',
    sessionId: 'conversation-session',
    mcpServers: { tasks: { command: 'task-mcp' } },
    taskStateMcpServers: { tasks: { command: 'task-mcp' } },
  },
  formalSpec: false,
};

function setStartResponse(content: string): void {
  mocks.callAIWithRetry.mockResolvedValueOnce({
    result: { success: true, content },
    sessionId: undefined,
  });
}

function choiceFailures(field: 'taskName' | 'startOptionId') {
  return [
    { failure: 'null choice', response: { result: { success: true, content: JSON.stringify({ [field]: null }) } } },
    { failure: 'invalid JSON', response: { result: { success: true, content: 'invalid JSON' } } },
    { failure: 'extra field', response: { result: { success: true, content: JSON.stringify({ [field]: 'unknown', extra: true }) } } },
    { failure: 'unknown candidate', response: { result: { success: true, content: JSON.stringify({ [field]: 'unknown' }) } } },
    { failure: 'missing result', response: { result: null, error: 'provider unavailable' } },
    { failure: 'unsuccessful result', response: { result: { success: false, content: 'provider failed' } } },
    { failure: 'thrown error', response: new Error('provider threw') },
  ];
}

function setChoiceFailure(response: ReturnType<typeof choiceFailures>[number]['response']): void {
  if (response instanceof Error) mocks.callAIWithRetry.mockRejectedValueOnce(response);
  else mocks.callAIWithRetry.mockResolvedValueOnce(response);
}

function expectNoRequeue(): void {
  expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  expect(mocks.requeueTask).not.toHaveBeenCalled();
  expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
}

function setPreparedStart(): void {
  mocks.prepareFailedTaskRetry.mockReturnValue(preparation);
  mocks.buildFailedTaskRetryStartContext.mockReturnValue({
    workflowName: 'development',
    workflowConfig: { steps: [] },
    workflowOverride: undefined,
    options: {},
    startOptions: {
      options: [
        { id: 'resume-checkpoint', label: 'Resume from implement', selectable: true },
        { id: 'heading:review', label: 'review:', selectable: false },
        { id: 'restart:implement', label: 'Restart implement', selectable: true },
      ],
      defaultId: 'resume-checkpoint',
    },
  });
  mocks.resolveFailedTaskRetryStart.mockImplementation((_context, id: string) => {
    if (id === 'resume-checkpoint') {
      return { label: 'Resume from implement', startStep: 'implement', resumePoint: undefined, restartPoint: undefined };
    }
    return { label: 'Restart implement', startStep: undefined, resumePoint: undefined, restartPoint: implementRestartPoint };
  });
}

function setInvalidSavedStart(savedStep = 'reviewers'): string {
  const workflowConfig = attachWorkflowOpaqueRef({
    name: 'default', initialStep: 'plan', maxSteps: 10,
    steps: ['plan', 'reviewers-v2'].map((name) => ({ name, personaDisplayName: name, instruction: name })),
  }, 'project:root');
  const resumePoint: WorkflowResumePoint = {
    version: 2,
    stack: [{ workflow: 'default', workflow_ref: 'project:root', step: savedStep, kind: 'agent', occurrence: 1 }],
    iteration: 4, elapsed_ms: 1000, workflow_call_invocations: {}, workflow_step_participations: {},
  };
  const startPathOptions = { projectCwd: options.cwd, lookupCwd: preparation.interactionCwd, resumePoint };
  const startOptions = buildTaskRetryStartOptions(workflowConfig, startPathOptions);
  mocks.prepareFailedTaskRetry.mockReturnValue({ ...preparation, previousWorkflow: 'default', resumePoint });
  mocks.buildFailedTaskRetryStartContext.mockReturnValue({
    workflowName: 'default', workflowConfig, workflowOverride: undefined,
    options: startPathOptions, startOptions,
  });
  mocks.resolveFailedTaskRetryStart.mockReturnValue({
    label: 'plan', startStep: undefined, resumePoint: undefined,
    restartPoint: { stack: [{ workflow: 'default', workflow_ref: 'project:root', step: 'plan', kind: 'agent' }] },
  });
  if (startOptions.resumeFailureReason === undefined) throw new Error('Expected an invalid saved start');
  return startOptions.resumeFailureReason;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callAIWithRetry.mockReset();
  mocks.hasInteractiveTerminal.mockReturnValue(true);
  mocks.useTty.mockReturnValue(true);
  mocks.listAllTaskItems.mockReturnValue([task]);
  mocks.loadWorkflowByIdentifier.mockReturnValue(exceededWorkflow);
  mocks.assertReusableWorktreePath.mockReset();
  mocks.resolveWorkflowCallTarget.mockReset();
  mocks.requeueTask.mockReset();
  mocks.confirmWithCancel.mockReset().mockResolvedValue({ kind: 'value', value: true });
  mocks.selectOption.mockReset().mockResolvedValue('save_task');
  setPreparedStart();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAssistantRetryCommand', () => {
  it.each(['failed', 'exceeded'] as const)('should return from %s requeue confirmation on Escape without changing the task', async (kind) => {
    mocks.listAllTaskItems.mockReturnValue([kind === 'failed' ? task : exceededTask]);
    if (kind === 'failed') setStartResponse('{"startOptionId":"resume-checkpoint"}');
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'cancelled' });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(mocks.confirmWithCancel).toHaveBeenCalledOnce();
    expect(notice).toContain('not changed');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
    expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
  });

  it('should keep the existing retry selection cancellation without saving a generated order', async () => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: '# Revised order' }, sessionId: undefined,
    });
    mocks.selectOption.mockResolvedValue(null);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('not changed');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });
  describe.each(['en', 'ja'] as const)('invalid saved start in %s', (lang) => {
    describe.each(['retry', 'requeue'] as const)('/%s', (command) => {
      it.each([true, false])('explains the reason before confirmation and respects approval=%s', async (approve) => {
        const reason = setInvalidSavedStart();
        const explanation = getLabel('tui.assistantRetry.resumeUnavailable', lang, { reason });
        setStartResponse('{"startOptionId":"restart:0"}');
        if (command === 'retry') {
          mocks.callAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: '# Revised order' } });
          mocks.selectOption.mockImplementationOnce(async () => {
            expect(mocks.info.mock.calls.map((call) => String(call[0])).join('\n')).toContain(explanation);
            expect(mocks.info.mock.calls.map((call) => String(call[0])).join('\n')).toContain('plan');
            expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
            return approve ? 'save_task' : 'continue';
          });
        } else {
          mocks.confirmWithCancel.mockImplementationOnce(async (message) => {
            expect(message).toEqual(expect.stringContaining(explanation));
            expect(message).toEqual(expect.stringContaining('plan'));
            expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
            return { kind: 'value', value: approve };
          });
        }

        const notice = await runAssistantRetryCommand({ ...options, lang, command });

        expect(JSON.parse(String(mocks.callAIWithRetry.mock.calls[0]?.[0]))).toMatchObject({ resumeFailureReason: reason });
        expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:0');
        if (approve) {
          expect(mocks.persistFailedTaskRetry).toHaveBeenCalledTimes(1);
          expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).toMatchObject({
            startStep: undefined, resumePoint: undefined,
            restartPoint: { stack: [{ workflow: 'default', workflow_ref: 'project:root', step: 'plan', kind: 'agent' }] },
            ...(command === 'retry' ? { revisedOrder: { content: '# Revised order', lang } } : {}),
          });
        } else {
          expect(notice).toContain(explanation);
          expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
        }
      });

      it.each([
        { result: { success: true, content: '{"startOptionId":null}' } },
        { result: { success: true, content: '{"startOptionId":"unknown"}' } },
        { result: null, error: 'provider unavailable' },
      ])('keeps the explanation when a start cannot be selected: %j', async (response) => {
        const reason = setInvalidSavedStart();
        mocks.callAIWithRetry.mockResolvedValueOnce(response);
        mocks.selectOption.mockResolvedValueOnce(null);

        const notice = await runAssistantRetryCommand({ ...options, lang, command });

        expect(notice).toContain(getLabel('tui.assistantRetry.resumeUnavailable', lang, { reason }));
        expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
        expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
        if (command === 'requeue') expect(mocks.selectOption).toHaveBeenCalledOnce();
        else expect(mocks.selectOption).not.toHaveBeenCalled();
        expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      });

      it('sanitizes the reason for terminal output while retaining selection input', async () => {
        const reason = setInvalidSavedStart('reviewers\u001b[2J\r\n\u0007\u009b0m');
        setStartResponse('{"startOptionId":null}');
        mocks.selectOption.mockResolvedValueOnce(null);

        const notice = await runAssistantRetryCommand({ ...options, lang, command });

        expect(notice).toContain(getLabel('tui.assistantRetry.resumeUnavailable', lang, {
          reason: sanitizeTerminalText(reason),
        }));
        expect(notice).not.toMatch(/[\u001b\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
        expect(JSON.parse(String(mocks.callAIWithRetry.mock.calls[0]?.[0]))).toMatchObject({ resumeFailureReason: reason });
        expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      });
    });

    it('retains the reason if revised-order generation fails', async () => {
      const reason = setInvalidSavedStart();
      setStartResponse('{"startOptionId":"restart:0"}');
      mocks.callAIWithRetry.mockRejectedValueOnce(new Error('revision failed'));

      const notice = await runAssistantRetryCommand({ ...options, lang });

      expect(notice).toContain(getLabel('tui.assistantRetry.resumeUnavailable', lang, { reason }));
      expect(mocks.selectOption).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
    });
  });

  it.each(['retry', 'requeue'] as const)('returns the invalid checkpoint diagnostic without selecting or persisting for /%s when no restart is available', async (command) => {
    const failure = new InvalidTaskRetryResumeWithoutRestartError('Saved step "reviewers" was not found');
    mocks.buildFailedTaskRetryStartContext.mockImplementationOnce(() => { throw failure; });

    const notice = await runAssistantRetryCommand({ ...options, command });

    expect(notice).toContain(failure.message);
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it.each(['retry', 'requeue'] as const)('refuses /%s on a non-interactive terminal before loading tasks or calling the provider', async (command) => {
    mocks.hasInteractiveTerminal.mockReturnValue(false);

    const notice = await runAssistantRetryCommand({ ...options, command });

    expect(notice).toContain('require an interactive terminal');
    expect(mocks.listAllTaskItems).not.toHaveBeenCalled();
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expectNoRequeue();
  });

  it.each(['retry', 'requeue'] as const)('refuses /%s on a terminal rejected by the TTY policy before loading tasks', async (command) => {
    mocks.useTty.mockReturnValue(false);

    const notice = await runAssistantRetryCommand({ ...options, command });

    expect(notice).toContain('require an interactive terminal');
    expect(mocks.listAllTaskItems).not.toHaveBeenCalled();
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expectNoRequeue();
  });

  it('returns without generating a choice when there are no eligible tasks', async () => {
    mocks.listAllTaskItems.mockReturnValue([{ ...task, kind: 'completed' }]);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('no tasks eligible');
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
  });

  it('does not include exceeded tasks in /retry candidates', async () => {
    mocks.listAllTaskItems.mockReturnValue([exceededTask]);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('no tasks eligible');
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
  });

  it('uses the exact selectable start ID and persists a confirmed failed-task requeue', async () => {
    setStartResponse('{"startOptionId":"restart:implement"}');
    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('pending again');
    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:implement');
    expect(mocks.confirmWithCancel).toHaveBeenCalledWith(
      'Return this task to the queue?\nTask: fix-quint-diagnostics\nSummary: Fix diagnostics\nWorkflow: development\nStart position: Restart implement',
      false,
    );
    expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
      task,
      projectDir: '/repo',
      startStep: undefined,
      restartPoint: implementRestartPoint,
    }));
    expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).toMatchObject({
      retryNote: expect.stringContaining('[Auto-requeue]'),
    });
    expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).not.toHaveProperty('revisedOrder');
    expect(mocks.selectOption).not.toHaveBeenCalled();
    const call = mocks.callAIWithRetry.mock.calls[0]!;
    expect(call[4]).toMatchObject({
      sessionId: 'conversation-session',
      mcpServers: undefined,
      taskStateMcpServers: undefined,
      disableSessionRetry: true,
    });
    expect(call[5]).toMatchObject({
      outputMode: 'silent',
      persistSession: false,
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });
    expect(call[5].onStream).toBeUndefined();
  });

  it.each([
    {
      field: 'task name',
      taskName: 'alternate-task',
      summary: 'Fix diagnostics',
      workflow: 'development',
      start: 'Resume from implement',
    },
    {
      field: 'summary',
      taskName: 'fix-quint-diagnostics',
      summary: 'Updated diagnostic summary',
      workflow: 'development',
      start: 'Resume from implement',
    },
    {
      field: 'workflow',
      taskName: 'fix-quint-diagnostics',
      summary: 'Fix diagnostics',
      workflow: 'alternate-workflow',
      start: 'Resume from implement',
    },
    {
      field: 'start position',
      taskName: 'fix-quint-diagnostics',
      summary: 'Fix diagnostics',
      workflow: 'development',
      start: 'Restart from review',
    },
  ])('uses the current $field in failed-task requeue confirmation', async ({ taskName, summary, workflow, start }) => {
    const selectedTask = { ...task, name: taskName, summary };
    mocks.listAllTaskItems.mockReturnValue([selectedTask]);
    mocks.prepareFailedTaskRetry.mockReturnValue({ ...preparation, previousWorkflow: workflow });
    mocks.resolveFailedTaskRetryStart.mockReturnValue({
      label: start,
      startStep: 'implement',
      resumePoint: undefined,
      restartPoint: undefined,
    });
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(mocks.confirmWithCancel).toHaveBeenCalledWith(
      `Return this task to the queue?\nTask: ${taskName}\nSummary: ${summary}\nWorkflow: ${workflow}\nStart position: ${start}`,
      false,
    );
  });

  it('uses a resumed provider session when there is no local conversation history', async () => {
    mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
    mocks.callAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: '{"taskName":"fix-quint-diagnostics"}' },
        sessionId: 'resumed-session',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: '{"startOptionId":"resume-checkpoint"}' },
        sessionId: 'resumed-session',
      })
      .mockResolvedValueOnce({
        result: { success: true, content: '# Revised order\n\nApply the requested repair.' },
        sessionId: 'resumed-session',
      });
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    await runAssistantRetryCommand({
      ...options,
      history: [],
      inlineText: '',
      sessionContext: { ...options.sessionContext, sessionId: 'resumed-session' },
    });

    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(3);
    for (const call of mocks.callAIWithRetry.mock.calls) {
      expect(call[4]).toMatchObject({
        sessionId: 'resumed-session',
        mcpServers: undefined,
        taskStateMcpServers: undefined,
        disableSessionRetry: true,
      });
      expect(call[5]).toMatchObject({
        persistSession: false,
        permissionMode: 'readonly',
        internalAgentIsolation: 'strict-readonly',
      });
    }
    for (const call of mocks.callAIWithRetry.mock.calls.slice(0, 2)) {
      expect(JSON.parse(String(call[0]))).toMatchObject({
        conversation: [],
        noTranscriptNote: expect.any(String),
      });
    }
  });

  it.each([
    ['null task name', '{"taskName":null}', 'could not identify'],
    ['an extra field', '{"taskName":"fix-quint-diagnostics","extra":true}', 'not available'],
    ['a code fence', '```json\n{"taskName":"fix-quint-diagnostics"}\n```', 'not available'],
    ['an unavailable task', '{"taskName":"not-a-candidate"}', 'not available'],
  ])('keeps /retry unresolved notices when task selection returns %s', async (_name, response, expected) => {
    mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: response },
      sessionId: undefined,
    });

    const notice = await runAssistantRetryCommand(options);

    expect(notice.toLowerCase()).toContain(expected);
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('selects an exact eligible task from multiple candidates using conversation and inline guidance', async () => {
    mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
    mocks.callAIWithRetry
      .mockResolvedValueOnce({
        result: { success: true, content: '{"taskName":"fix-quint-diagnostics"}' },
        sessionId: undefined,
      })
      .mockResolvedValueOnce({
        result: { success: true, content: '{"startOptionId":"resume-checkpoint"}' },
        sessionId: undefined,
      });
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    const notice = await runAssistantRetryCommand({
      ...options,
      command: 'requeue',
      inlineText: 'Use the selected task and resume from its failure.',
    });

    expect(notice).toContain('not changed');
    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
    const taskPrompt = JSON.parse(String(mocks.callAIWithRetry.mock.calls[0]?.[0])) as {
      stage: string;
      candidates: Array<{ name: string }>;
    };
    expect(taskPrompt.stage).toBe('task');
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(taskPrompt.candidates.map((candidate) => candidate.name)).toEqual([
      'fix-quint-diagnostics',
      'another-task',
    ]);
    expect(mocks.prepareFailedTaskRetry).toHaveBeenCalledWith(task, '/repo');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  describe.each(['en', 'ja'] as const)('inline command origin in %s', (lang) => {
    it.each([
      true, false,
    ])('keeps /retry guidance in selection and order revision when history=%s', async (hasHistory) => {
      const command = 'retry';
      const note = lang === 'ja' ? '訂正、Androidも対象にしてください' : 'Correction: include Android too.';
      const history = hasHistory ? options.history : [];
      mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
      mocks.callAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: '{"taskName":"fix-quint-diagnostics"}' } });
      setStartResponse('{"startOptionId":"restart:implement"}');
      const revised = '# Revised order\n\nSupport iOS and Android.';
      mocks.callAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: revised } });

      await runAssistantRetryCommand({
        ...options, lang, command, inlineText: note, history,
        sessionContext: { ...options.sessionContext, sessionId: hasHistory ? options.sessionContext.sessionId : undefined },
      });

      expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(3);
      for (const [prompt, system] of mocks.callAIWithRetry.mock.calls.slice(0, 2)) {
        const input = JSON.parse(String(prompt)) as Record<string, unknown>;
        expect(input).toMatchObject({ command, conversation: history });
        expect(String(system)).toContain(note);
      }
      const prompt = String(mocks.callAIWithRetry.mock.calls[2]?.[0]);
      expect(prompt).toContain(preparation.previousOrderContent);
      expect(prompt).toContain(note);
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({ revisedOrder: { content: revised, lang } }));
      expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).toMatchObject({ restartPoint: implementRestartPoint });
    });
  });

  it.each(['unknown-option', 'heading:review'])('keeps /retry rejection of unavailable start option %s without prompting', async (startOptionId) => {
    setStartResponse(JSON.stringify({ startOptionId }));

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('not available');
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('keeps /retry unresolved start notice without prompting', async () => {
    setStartResponse('{"startOptionId":null}');

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('could not identify');
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('keeps /retry provider failure notice without prompting', async () => {
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: null,
      sessionId: undefined,
      error: 'provider unavailable',
    });

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('provider unavailable');
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  describe('/requeue human selection', () => {
    it.each(['en', 'ja'] as const)('keeps the invalid checkpoint explanation through human start selection and confirmation in %s', async (lang) => {
      const reason = setInvalidSavedStart();
      const explanation = getLabel('tui.assistantRetry.resumeUnavailable', lang, { reason });
      setStartResponse('{"startOptionId":null}');
      mocks.selectOption.mockImplementationOnce(async (...args) => {
        expect(args[0]).toEqual(expect.stringContaining(explanation));
        expectNoRequeue();
        return 'restart:0';
      });
      mocks.confirmWithCancel.mockImplementationOnce(async (message) => {
        expect(message).toContain(explanation);
        expect(message).toContain('plan');
        expectNoRequeue();
        return { kind: 'value', value: true };
      });

      await runAssistantRetryCommand({ ...options, lang, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).toHaveBeenCalledOnce();
      expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:0');
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledOnce();
    });

    it.each(choiceFailures('taskName'))('offers eligible tasks after $failure and uses the human choice', async ({ response }) => {
      const otherTask = { ...task, name: 'another-task', summary: 'Repair another parser' };
      mocks.listAllTaskItems.mockReturnValue([
        task, otherTask, exceededTask,
        ...(['pending', 'running', 'completed'] as const).map((kind) => ({ ...task, kind, name: `${kind}-task` })),
      ]);
      setChoiceFailure(response);
      setStartResponse('{"startOptionId":"restart:implement"}');
      mocks.selectOption.mockResolvedValueOnce(otherTask.name);

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string; label: string }>;
      expect(choices.map((choice) => choice.value)).toEqual([task.name, otherTask.name, exceededTask.name]);
      expect(choices.find((choice) => choice.value === otherTask.name)?.label).toContain(otherTask.name);
      expect(mocks.prepareFailedTaskRetry).toHaveBeenCalledWith(otherTask, options.cwd);
      expect(JSON.parse(mocks.callAIWithRetry.mock.calls[1]![0]).task.name).toBe(otherTask.name);
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({ task: otherTask }));
      expect(notice).toContain(otherTask.name);
      expect(notice).toContain('pending again');
      expect(mocks.requeueTask).not.toHaveBeenCalled();
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
    });

    it('routes a human-selected exceeded task to its saved-position operation', async () => {
      mocks.listAllTaskItems.mockReturnValue([task, exceededTask]);
      setStartResponse('{"taskName":null}');
      mocks.selectOption.mockResolvedValueOnce(exceededTask.name);

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('review'), false);
      expect(mocks.requeueExceededTask).toHaveBeenCalledWith(exceededTask.name);
      expect(mocks.prepareFailedTaskRetry).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      expect(mocks.requeueTask).not.toHaveBeenCalled();
      expect(notice).toContain(exceededTask.name);
      expect(notice).toContain('pending again');
    });

    it('sanitizes human task labels while preserving the selected task identity', async () => {
      const unsafeTask = { ...task, name: 'parser\u001b[2J\r\n\u0007', summary: 'Summary\u001b]0;title\u0007' };
      mocks.listAllTaskItems.mockReturnValue([task, unsafeTask]);
      setStartResponse('{"taskName":null}');
      setStartResponse('{"startOptionId":"restart:implement"}');
      mocks.selectOption.mockResolvedValueOnce(unsafeTask.name);

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string; label: string; description?: string }>;
      expect(choices.map((choice) => choice.value)).toContain(unsafeTask.name);
      for (const choice of choices) {
        expect(choice.label).not.toMatch(/[\u001b\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
        if (choice.description !== undefined) expect(choice.description).not.toMatch(/[\u001b\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
      }
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({ task: unsafeTask }));
      expect(notice).toContain(sanitizeTerminalText(unsafeTask.name));
    });

    it.each([
      ...choiceFailures('startOptionId'),
      { failure: 'non-selectable heading', response: { result: { success: true, content: '{"startOptionId":"heading:review"}' } } },
    ])('offers only selectable failed-task starts after $failure and persists the chosen start after confirmation', async ({ response }) => {
      setChoiceFailure(response);
      mocks.selectOption.mockResolvedValueOnce('restart:implement');
      mocks.confirmWithCancel.mockImplementationOnce(async (message) => {
        expect(message).toContain('Restart implement');
        expectNoRequeue();
        return { kind: 'value', value: true };
      });

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string }>;
      expect(choices.map((choice) => choice.value)).toEqual(['resume-checkpoint', 'restart:implement']);
      expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:implement');
      expect(mocks.confirmWithCancel).toHaveBeenCalledOnce();
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
        task, startStep: undefined, resumePoint: undefined, restartPoint: implementRestartPoint,
        sourceRunSlug: 'failed-run',
      }));
      expect(mocks.persistFailedTaskRetry.mock.calls[0]![0]).not.toHaveProperty('revisedOrder');
      expect(notice).toContain(task.name);
      expect(notice).toContain('pending again');
    });

    it('continues from a human-selected checkpoint without turning it into a restart', async () => {
      setStartResponse('{"startOptionId":null}');
      mocks.selectOption.mockResolvedValueOnce('resume-checkpoint');
      mocks.resolveFailedTaskRetryStart.mockReturnValueOnce({
        label: 'Resume from review', startStep: 'review',
        resumePoint: exceededResumePoint, restartPoint: undefined,
      });

      await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'resume-checkpoint');
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Resume from review'), false);
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
        startStep: 'review', resumePoint: exceededResumePoint, restartPoint: undefined,
      }));
    });

    it.each(['task', 'failed start', 'exceeded start'] as const)('returns an unchanged notice and performs no confirmation or persistence when %s selection is cancelled', async (stage) => {
      if (stage === 'task') mocks.listAllTaskItems.mockReturnValue([task, exceededTask]);
      if (stage === 'exceeded start') mocks.listAllTaskItems.mockReturnValue([exceededTask]);
      setStartResponse(stage === 'task' ? '{"taskName":null}' : '{"startOptionId":null}');
      mocks.selectOption.mockResolvedValueOnce(null);

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue', inlineText: 'Choose where to resume.' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
      expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
      expectNoRequeue();
      expect(notice).toContain('not changed');
    });

    it.each(['task', 'failed start', 'exceeded start'] as const)('returns a failure without changing tasks when %s selection throws', async (stage) => {
      if (stage === 'task') mocks.listAllTaskItems.mockReturnValue([task, exceededTask]);
      if (stage === 'exceeded start') mocks.listAllTaskItems.mockReturnValue([exceededTask]);
      setStartResponse(stage === 'task' ? '{"taskName":null}' : '{"startOptionId":null}');
      mocks.selectOption.mockRejectedValueOnce(new Error('Selection UI failed'));

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue', inlineText: 'Choose where to resume.' });

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
      expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
      expectNoRequeue();
      expect(notice).toContain('Selection UI failed');
    });

    it('keeps both human selections connected when AI cannot choose either task or start', async () => {
      mocks.listAllTaskItems.mockReturnValue([task, exceededTask]);
      setStartResponse('{"taskName":null}');
      setStartResponse('{"startOptionId":null}');
      mocks.selectOption.mockResolvedValueOnce(task.name).mockResolvedValueOnce('restart:implement');
      mocks.confirmWithCancel.mockResolvedValueOnce({ kind: 'cancelled' });

      const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

      expect(mocks.selectOption).toHaveBeenCalledTimes(2);
      expect(mocks.prepareFailedTaskRetry).toHaveBeenCalledWith(task, options.cwd);
      expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:implement');
      expect(mocks.confirmWithCancel).toHaveBeenCalledOnce();
      expectNoRequeue();
      expect(notice).toContain('not changed');
    });

  });

  describe.each(['en', 'ja'] as const)('/requeue conversation guidance in %s', (lang) => {
    it.each([true, false])('appends free text once to both AI queries without mutating history when history=%s', async (hasHistory) => {
      const history = hasHistory ? options.history.map((message) => ({ ...message })) : [];
      const originalHistory = structuredClone(history);
      const note = lang === 'ja' ? '前に話した件を見直してから再開して' : 'Revisit the earlier issue before resuming.';
      mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
      setStartResponse('{"taskName":"fix-quint-diagnostics"}');
      setStartResponse('{"startOptionId":"restart:implement"}');

      await runAssistantRetryCommand({ ...options, lang, command: 'requeue', inlineText: note, history });

      expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
      for (const [prompt, system] of mocks.callAIWithRetry.mock.calls) {
        expect(JSON.parse(prompt).conversation).toEqual([...originalHistory, { role: 'user', content: note }]);
        expect(String(system)).not.toContain(note);
      }
      expect(history).toEqual(originalHistory);
      expect(mocks.selectOption).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).toHaveBeenCalledOnce();
    });

    it.each(['', '   '])('does not append an empty utterance for inline text %j', async (inlineText) => {
      mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
      setStartResponse('{"taskName":"fix-quint-diagnostics"}');
      setStartResponse('{"startOptionId":"resume-checkpoint"}');

      await runAssistantRetryCommand({ ...options, lang, command: 'requeue', inlineText });

      expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
      for (const [prompt] of mocks.callAIWithRetry.mock.calls) expect(JSON.parse(prompt).conversation).toEqual(options.history);
    });
  });

  it('uses the AI decision even when free text exactly matches a different candidate name', async () => {
    const otherTask = { ...task, name: 'another-task' };
    mocks.listAllTaskItems.mockReturnValue([task, otherTask]);
    setStartResponse('{"taskName":"another-task"}');
    setStartResponse('{"startOptionId":"restart:implement"}');

    await runAssistantRetryCommand({ ...options, command: 'requeue', inlineText: task.name });

    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
    expect(mocks.prepareFailedTaskRetry).toHaveBeenCalledWith(otherTask, options.cwd);
    expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({ task: otherTask }));
  });

  it('shows the revised full order and saves only when Save task is selected', async () => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    const revisedOrder = '# Revised order\n\nApply the parser fix.\n\nAcceptance: preserve the original semantics.';
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: revisedOrder },
      sessionId: undefined,
    });
    mocks.selectOption.mockImplementationOnce(async () => {
      const displayed = mocks.info.mock.calls.map((call) => String(call[0])).join('\n');
      expect(displayed).toContain(revisedOrder);
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      return 'save_task';
    });

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('revised task');
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining(
      'Task: fix-quint-diagnostics\nSummary: Fix diagnostics\nWorkflow: development\nStart position: Resume from implement',
    ));
    expect(mocks.selectOption).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: 'save_task' }),
        expect.objectContaining({ value: 'continue' }),
      ]),
    );
    expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
      task,
      retryNote: undefined,
      startStep: 'implement',
      revisedOrder: {
        content: revisedOrder,
        lang: 'en',
      },
    }));
  });

  it('sanitizes terminal control sequences without changing the saved revised order', async () => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    const revisedOrder = '# Revised order\n\nFirst paragraph.\n\nSecond paragraph: \u001b[2J CSI \u001b]0;title\u0007 OSC \u000d CR \u009b31m C1.';
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: revisedOrder },
      sessionId: undefined,
    });
    mocks.selectOption.mockResolvedValue('save_task');

    await runAssistantRetryCommand(options);

    const displayed = mocks.info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(displayed).toContain('# Revised order\n\nFirst paragraph.\n\nSecond paragraph:  CSI ');
    expect(displayed).toContain('OSC \\r CR \\x9b31m C1.');
    expect(displayed).not.toMatch(/[\u001b\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
      revisedOrder: { content: revisedOrder, lang: 'en' },
    }));
  });

  it('does not save when Continue is selected', async () => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: '# Revised order' },
      sessionId: undefined,
    });
    mocks.selectOption.mockResolvedValue('continue');

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('not changed');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('does not offer an empty generated order for saving', async () => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: ' \n ' },
      sessionId: undefined,
    });

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('could not be prepared');
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('requeues exceeded tasks with their saved stopping position and no generated start option', async () => {
    mocks.listAllTaskItems.mockReturnValue([exceededTask]);
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: true });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('pending again');
    expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('review'), false);
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.requeueExceededTask).toHaveBeenCalledWith('long-running-task');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('returns a notice when an exceeded task cannot be requeued after confirmation', async () => {
    mocks.listAllTaskItems.mockReturnValue([exceededTask]);
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mocks.requeueExceededTask.mockImplementationOnce(() => {
      throw new Error('Task not found: long-running-task (exceeded)');
    });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('could not be prepared');
    expect(notice).toContain('Task not found: long-running-task (exceeded)');
  });

  describe('exceeded start selection without a saved position or inline text', () => {
    const requeueOptions = { ...options, command: 'requeue' as const };

    beforeEach(() => mocks.listAllTaskItems.mockReturnValue([exceededTaskWithoutStart]));

    it.each(['implement', 'review'])('offers available starts and requeues the selected %s only after confirmation', async (step) => {
      mocks.selectOption.mockImplementationOnce(async () => {
        expectNoRequeue();
        expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
        return step === 'implement' ? 'restart:0' : 'restart:1';
      });
      mocks.confirmWithCancel.mockImplementationOnce(async (message) => {
        expect(message).toContain(`Restart: "${step}"`);
        expect(message).toContain(exceededTaskWithoutStart.name);
        expectNoRequeue();
        return { kind: 'value', value: true };
      });

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.selectOption.mock.calls[0]![1]).toEqual([
        expect.objectContaining({ value: 'restart:0', label: 'Restart: "implement"' }),
        expect.objectContaining({ value: 'restart:1', label: 'Restart: "review"' }),
      ]);
      expect(mocks.confirmWithCancel).toHaveBeenCalledOnce();
      expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
      expect(mocks.assertReusableWorktreePath).toHaveBeenCalledWith(options.cwd, exceededTaskWithoutStart.worktreePath);
      expect(mocks.loadWorkflowByIdentifier).toHaveBeenCalledWith('development', options.cwd, { lookupCwd: exceededTaskWithoutStart.worktreePath });
      expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTaskWithoutStart.name, ['exceeded'], {
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step, kind: 'agent' }] },
        retryNote: 'Existing note',
      });
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      expect(notice).toContain(exceededTaskWithoutStart.name);
      expect(notice).toContain('pending again');
    });

    it.each(['AI', 'human', 'cancel'] as const)('connects multiple-task selection to the missing-position task: %s', async (selection) => {
      mocks.listAllTaskItems.mockReturnValue([task, exceededTaskWithoutStart]);
      setStartResponse(JSON.stringify({ taskName: selection === 'AI' ? exceededTaskWithoutStart.name : null }));
      if (selection !== 'AI') mocks.selectOption.mockResolvedValueOnce(selection === 'cancel' ? null : exceededTaskWithoutStart.name);
      if (selection !== 'cancel') mocks.selectOption.mockResolvedValueOnce('restart:1');

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.callAIWithRetry).toHaveBeenCalledOnce();
      expect(JSON.parse(mocks.callAIWithRetry.mock.calls[0]![0]).stage).toBe('task');
      expect(mocks.selectOption).toHaveBeenCalledTimes(selection === 'human' ? 2 : 1);
      expect(mocks.prepareFailedTaskRetry).not.toHaveBeenCalled();
      if (selection === 'cancel') {
        expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
        expect(mocks.loadWorkflowByIdentifier).not.toHaveBeenCalled();
        expectNoRequeue();
        expect(notice).toContain('not changed');
      } else {
        expect(mocks.selectOption.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining([
          expect.objectContaining({ value: 'restart:1' }),
        ]));
        expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTaskWithoutStart.name, ['exceeded'], {
          restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'review', kind: 'agent' }] },
          retryNote: 'Existing note',
        });
        expect(notice).toContain(exceededTaskWithoutStart.name);
        expect(notice).toContain('pending again');
      }
    });

    it.each(['resume-checkpoint', 'restart:1'])('preserves continuation and restart ownership for human choice %s', async (id) => {
      mocks.listAllTaskItems.mockReturnValue([{ ...exceededTaskWithoutStart, data: {
        ...exceededTaskWithoutStart.data!, resume_point: exceededResumePoint,
      } }]);
      mocks.selectOption.mockResolvedValueOnce(id);

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.selectOption.mock.calls[0]![1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'resume-checkpoint' }),
        expect.objectContaining({ value: 'restart:1' }),
      ]));
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(id === 'resume-checkpoint' ? 'Continue:' : 'Restart:'), false);
      expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTaskWithoutStart.name, ['exceeded'], id === 'resume-checkpoint' ? {
        startStep: 'review', resumePoint: exceededResumePoint, retryNote: 'Existing note',
      } : {
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'review', kind: 'agent' }] },
        retryNote: 'Existing note',
      });
      expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(notice).toContain('pending again');
    });

    it.each(['start', 'confirmation'] as const)('keeps the task unchanged on %s cancellation', async (stage) => {
      mocks.selectOption.mockResolvedValueOnce(stage === 'start' ? null : 'restart:1');
      mocks.confirmWithCancel.mockResolvedValueOnce({ kind: 'cancelled' });

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1);
      expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
      expectNoRequeue();
      expect(notice).toContain('not changed');
    });

    it.each([true, false])('only offers selectable starts when a workflow call child resolves=%s', async (resolved) => {
      const root = attachWorkflowOpaqueRef({
        name: 'development', initialStep: 'delegate', maxSteps: 10,
        steps: [{ name: 'delegate', kind: 'workflow_call' as const, call: 'child', personaDisplayName: 'delegate', instruction: '' }],
      }, 'project:development');
      const child = attachWorkflowOpaqueRef({
        name: 'child', initialStep: 'review', maxSteps: 10, subworkflow: { callable: true },
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: 'Review' }],
      }, 'project:child');
      mocks.loadWorkflowByIdentifier.mockReturnValueOnce(root);
      mocks.resolveWorkflowCallTarget.mockReturnValue(resolved ? child : null);
      mocks.selectOption.mockResolvedValueOnce('restart:0.0');

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
      if (resolved) {
        expect(mocks.selectOption).toHaveBeenCalledOnce();
        expect(mocks.selectOption.mock.calls[0]![1]).toEqual([expect.objectContaining({ value: 'restart:0.0' })]);
        expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('review'), false);
        expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTaskWithoutStart.name, ['exceeded'], {
          restartPoint: { stack: [
            { workflow: 'development', workflow_ref: 'project:development', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
            { workflow: 'child', workflow_ref: 'project:child', step: 'review', kind: 'agent' },
          ] },
          retryNote: 'Existing note',
        });
        expect(notice).toContain('pending again');
      } else {
        expect(mocks.selectOption).not.toHaveBeenCalled();
        expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
        expectNoRequeue();
        expect(notice).toContain('could not be prepared');
      }
    });

    it.each(['workflow', 'worktree'] as const)('does not prompt or change the task when %s resolution fails', async (failure) => {
      if (failure === 'workflow') mocks.loadWorkflowByIdentifier.mockReturnValueOnce(null);
      else mocks.assertReusableWorktreePath.mockImplementationOnce(() => { throw new Error('invalid worktree'); });

      const notice = await runAssistantRetryCommand(requeueOptions);

      expect(mocks.selectOption).not.toHaveBeenCalled();
      expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
      expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
      expectNoRequeue();
      expect(notice).toContain('could not be prepared');
    });
  });

  describe('exceeded inline start selection', () => {
    const inlineOptions = { ...options, command: 'requeue' as const, inlineText: 'Restart from implement.' };

    beforeEach(() => mocks.listAllTaskItems.mockReturnValue([exceededTask]));

    it('confirms and queues the explicitly selected restart instead of the saved position', async () => {
      setStartResponse('{"startOptionId":"restart:0"}');
      await runAssistantRetryCommand(inlineOptions);
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Restart: "implement"'), false);
      expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTask.name, ['exceeded'], {
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'implement', kind: 'agent' }] },
        retryNote: undefined,
      });
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(1);
      expect(mocks.selectOption).not.toHaveBeenCalled();
      const payload = JSON.parse(mocks.callAIWithRetry.mock.calls[0]![0]);
      expect(payload.startOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'continue-saved-position', operation: 'continue' }),
        expect.objectContaining({ id: 'restart:1', operation: 'restart' }),
      ]));
      expect(mocks.assertReusableWorktreePath).toHaveBeenCalledWith(options.cwd, exceededTask.worktreePath);
      expect(mocks.loadWorkflowByIdentifier).toHaveBeenCalledWith('development', options.cwd, { lookupCwd: exceededTask.worktreePath });
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
    });

    it('continues from the saved position without a checkpoint', async () => {
      setStartResponse('{"startOptionId":"continue-saved-position"}');
      await runAssistantRetryCommand({ ...inlineOptions, inlineText: 'implement is only an example. Continue from saved review.' });
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Continue: Saved stopping position: review'), false);
      expect(mocks.requeueExceededTask).toHaveBeenCalledWith(exceededTask.name);
      expect(mocks.requeueTask).not.toHaveBeenCalled();
    });

    it.each([
      ['resume-checkpoint', 'Continue', true],
      ['restart:1', 'Restart', false],
    ] as const)('keeps continuing and restarting review distinct: %s', async (id, operation, resume) => {
      mocks.listAllTaskItems.mockReturnValue([{ ...exceededTask, data: { ...exceededTask.data!, resume_point: exceededResumePoint, retry_note: 'Existing note' } }]);
      setStartResponse(JSON.stringify({ startOptionId: id }));
      await runAssistantRetryCommand(inlineOptions);
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(`${operation}:`), false);
      const updates = mocks.requeueTask.mock.calls[0]![2];
      expect(updates.retryNote).toBe('Existing note');
      expect(updates.resumePoint).toEqual(resume ? exceededResumePoint : undefined);
      expect(updates.restartPoint?.stack.at(-1)?.step).toBe(resume ? undefined : 'review');
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
    });

    it('does not replace an invalid checkpoint with the saved start step', async () => {
      mocks.listAllTaskItems.mockReturnValue([{ ...exceededTask, data: {
        ...exceededTask.data!,
        resume_point: { ...exceededResumePoint, stack: [{ ...exceededResumePoint.stack[0]!, step: 'removed-review' }] },
      } }]);
      setStartResponse('{"startOptionId":"continue-saved-position"}');
      mocks.selectOption.mockResolvedValueOnce(null);
      const notice = await runAssistantRetryCommand(inlineOptions);
      const payload = JSON.parse(mocks.callAIWithRetry.mock.calls[0]![0]);
      expect(payload.resumeFailureReason).toContain('removed-review');
      expect(payload.startOptions.every((option: { operation: string }) => option.operation === 'restart')).toBe(true);
      expect(notice).toContain('removed-review');
      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string }>;
      expect(choices.map((choice) => choice.value)).toEqual(['restart:0', 'restart:1']);
      expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
      expect(mocks.requeueTask).not.toHaveBeenCalled();
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
    });

    it.each(choiceFailures('startOptionId'))('offers exceeded starts after $failure and queues the human-selected restart', async ({ response }) => {
      setChoiceFailure(response);
      mocks.selectOption.mockResolvedValueOnce('restart:1');
      const notice = await runAssistantRetryCommand(inlineOptions);

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string }>;
      expect(choices.map((choice) => choice.value)).toEqual(['continue-saved-position', 'restart:0', 'restart:1']);
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Restart: "review"'), false);
      expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTask.name, ['exceeded'], {
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'review', kind: 'agent' }] },
        retryNote: undefined,
      });
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(notice).toContain(exceededTask.name);
      expect(notice).toContain('pending again');
    });

    it('keeps the saved-position continuation distinct from a restart at the same step after human selection', async () => {
      setStartResponse('{"startOptionId":null}');
      mocks.selectOption.mockResolvedValueOnce('continue-saved-position');

      await runAssistantRetryCommand(inlineOptions);

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Continue: Saved stopping position: review'), false);
      expect(mocks.requeueExceededTask).toHaveBeenCalledWith(exceededTask.name);
      expect(mocks.requeueTask).not.toHaveBeenCalled();
    });

    it.each([
      ['resume-checkpoint', 'Continue', true],
      ['restart:1', 'Restart', false],
    ] as const)('preserves the operation and retry note for human choice %s when continue and restart share review', async (id, operation, resume) => {
      mocks.listAllTaskItems.mockReturnValue([{ ...exceededTask, data: {
        ...exceededTask.data!, resume_point: exceededResumePoint, retry_note: 'Existing note',
      } }]);
      setStartResponse('{"startOptionId":null}');
      mocks.selectOption.mockResolvedValueOnce(id);

      await runAssistantRetryCommand(inlineOptions);

      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string }>;
      expect(choices.map((choice) => choice.value)).toContain('resume-checkpoint');
      expect(choices.map((choice) => choice.value)).toContain('restart:1');
      expect(mocks.confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(`${operation}:`), false);
      expect(mocks.requeueTask).toHaveBeenCalledWith(exceededTask.name, ['exceeded'], resume ? {
        startStep: 'review', resumePoint: exceededResumePoint, retryNote: 'Existing note',
      } : {
        restartPoint: { stack: [{ workflow: 'development', workflow_ref: 'project:development', step: 'review', kind: 'agent' }] },
        retryNote: 'Existing note',
      });
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
    });

    it('rejects a real non-selectable workflow call heading instead of starting its child', async () => {
      const root = attachWorkflowOpaqueRef({
        name: 'development', initialStep: 'delegate', maxSteps: 10,
        steps: [{ name: 'delegate', kind: 'workflow_call' as const, call: 'child', personaDisplayName: 'delegate', instruction: '' }],
      }, 'project:development');
      const child = attachWorkflowOpaqueRef({
        name: 'child', initialStep: 'review', maxSteps: 10, subworkflow: { callable: true },
        steps: [{ name: 'review', personaDisplayName: 'review', instruction: 'Review' }],
      }, 'project:child');
      mocks.loadWorkflowByIdentifier.mockReturnValueOnce(root);
      mocks.resolveWorkflowCallTarget.mockReturnValue(child);
      setStartResponse('{"startOptionId":"heading:0"}');
      mocks.selectOption.mockResolvedValueOnce(null);
      await runAssistantRetryCommand(inlineOptions);
      const payload = JSON.parse(mocks.callAIWithRetry.mock.calls[0]![0]);
      expect(payload.startOptions).toEqual([expect.objectContaining({ id: 'restart:0.0', operation: 'restart' })]);
      expect(mocks.selectOption).toHaveBeenCalledOnce();
      const choices = mocks.selectOption.mock.calls[0]![1] as Array<{ value: string }>;
      expect(choices.map((choice) => choice.value)).toEqual(['restart:0.0']);
      expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
      expect(mocks.requeueTask).not.toHaveBeenCalled();
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
    });

    it.each(['provider', 'workflow', 'worktree', 'cancel', 'status'] as const)('does not requeue on %s failure or cancellation', async (failure) => {
      mocks.selectOption.mockResolvedValueOnce(null);
      if (failure === 'provider') mocks.callAIWithRetry.mockResolvedValueOnce({ result: null, error: 'unavailable' });
      else setStartResponse('{"startOptionId":"restart:0"}');
      if (failure === 'workflow') mocks.loadWorkflowByIdentifier.mockReturnValueOnce(null);
      if (failure === 'worktree') mocks.assertReusableWorktreePath.mockImplementationOnce(() => { throw new Error('invalid worktree'); });
      if (failure === 'cancel') mocks.confirmWithCancel.mockResolvedValueOnce({ kind: 'value', value: false });
      if (failure === 'status') mocks.requeueTask.mockImplementationOnce(() => { throw new Error('expected status: exceeded'); });
      const notice = await runAssistantRetryCommand(inlineOptions);
      expect(notice).toBeTruthy();
      if (failure !== 'status') expect(mocks.requeueTask).not.toHaveBeenCalled();
      expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
      expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
    });
  });

  it.each([
    { field: 'saved stopping position', startStep: 'review-tests', iteration: 8 },
    { field: 'iteration', startStep: 'review', iteration: 9 },
  ])('uses the current exceeded-task $field in its confirmation', async ({ startStep, iteration }) => {
    const selectedTask: TaskListItem = {
      ...exceededTask,
      data: {
        ...exceededTask.data,
        task: exceededTask.data?.task ?? '',
        start_step: startStep,
      },
      exceededCurrentIteration: iteration,
    };
    mocks.listAllTaskItems.mockReturnValue([selectedTask]);
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(mocks.confirmWithCancel).toHaveBeenCalledWith(
      `Return this task to the queue?\nTask: long-running-task\nSummary: Resume the stopped task\nWorkflow: development\nStart position: Saved stopping position: ${startStep} (iteration ${iteration})`,
      false,
    );
    expect(mocks.requeueExceededTask).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: 'null response',
      result: { result: null, sessionId: undefined, error: 'provider unavailable' },
    },
    {
      failure: 'unsuccessful response',
      result: { result: { success: false, content: 'revision rejected' }, sessionId: undefined },
    },
    {
      failure: 'thrown error',
      result: new Error('revision threw'),
    },
  ])('stops before confirmation and persistence after revised-order generation returns a $failure', async ({ result }) => {
    setStartResponse('{"startOptionId":"resume-checkpoint"}');
    if (result instanceof Error) {
      mocks.callAIWithRetry.mockRejectedValueOnce(result);
    } else {
      mocks.callAIWithRetry.mockResolvedValueOnce(result);
    }

    const notice = await runAssistantRetryCommand(options);

    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
    expect(notice).toContain('could not be prepared');
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });
});
