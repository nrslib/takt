vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkTaskNameProvider: vi.fn(async () => undefined), checkTaskProviders: vi.fn(async () => undefined), terminalProviderConfirmation: vi.fn(() => undefined) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import type { FailedTaskRetryPreparation } from '../features/tasks/taskRetryPreparation.js';
import type { AssistantRetryCommandOptions } from '../features/interactive/assistantRetryCommand.js';
import { buildTaskRetryStartOptions, InvalidTaskRetryResumeWithoutRestartError } from '../features/tasks/list/taskRetryStartSelection.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getLabel } from '../shared/i18n/index.js';
import { sanitizeTerminalText } from '../shared/utils/text.js';
import type { WorkflowResumePoint } from '../core/models/index.js';

const mocks = vi.hoisted(() => ({
  callAIWithRetry: vi.fn(),
  hasInteractiveTerminal: vi.fn(() => true),
  useTty: vi.fn(() => true),
  listAllTaskItems: vi.fn<() => TaskListItem[]>(() => []),
  requeueExceededTask: vi.fn(),
  prepareFailedTaskRetry: vi.fn(),
  buildFailedTaskRetryStartContext: vi.fn(),
  resolveFailedTaskRetryStart: vi.fn(),
  persistFailedTaskRetry: vi.fn(),
  confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
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
    },
  };
});

vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: (...args: unknown[]) => mocks.callAIWithRetry(...args),
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
  confirm: (...args: unknown[]) => mocks.confirm(...args),
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

const preparation: FailedTaskRetryPreparation = {
  worktreePath: task.worktreePath!,
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
    return { label: 'Restart implement', startStep: undefined, resumePoint: undefined, restartPoint: { step: 'implement' } };
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
  const startPathOptions = { projectCwd: options.cwd, lookupCwd: preparation.worktreePath, resumePoint };
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
  mocks.hasInteractiveTerminal.mockReturnValue(true);
  mocks.useTty.mockReturnValue(true);
  mocks.listAllTaskItems.mockReturnValue([task]);
  mocks.confirm.mockResolvedValue(true);
  mocks.selectOption.mockResolvedValue('save_task');
  setPreparedStart();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAssistantRetryCommand', () => {
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
          mocks.confirm.mockImplementationOnce(async (message) => {
            expect(message).toEqual(expect.stringContaining(explanation));
            expect(message).toEqual(expect.stringContaining('plan'));
            expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
            return approve;
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

        const notice = await runAssistantRetryCommand({ ...options, lang, command });

        expect(notice).toContain(getLabel('tui.assistantRetry.resumeUnavailable', lang, { reason }));
        expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.selectOption).not.toHaveBeenCalled();
        expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
      });

      it('sanitizes the reason for terminal output while retaining selection input', async () => {
        const reason = setInvalidSavedStart('reviewers\u001b[2J\r\n\u0007\u009b0m');
        setStartResponse('{"startOptionId":null}');

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

  it('returns the invalid checkpoint diagnostic without selecting or persisting when no restart is available', async () => {
    const failure = new InvalidTaskRetryResumeWithoutRestartError('Saved step "reviewers" was not found');
    mocks.buildFailedTaskRetryStartContext.mockImplementationOnce(() => { throw failure; });

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain(failure.message);
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.resolveFailedTaskRetryStart).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('refuses a non-interactive terminal before loading tasks or calling the provider', async () => {
    mocks.hasInteractiveTerminal.mockReturnValue(false);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('require an interactive terminal');
    expect(mocks.listAllTaskItems).not.toHaveBeenCalled();
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('refuses a terminal rejected by the TTY policy before loading tasks', async () => {
    mocks.useTty.mockReturnValue(false);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('require an interactive terminal');
    expect(mocks.listAllTaskItems).not.toHaveBeenCalled();
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
  });

  it('returns without generating a choice when there are no eligible tasks', async () => {
    mocks.listAllTaskItems.mockReturnValue([{ ...task, kind: 'completed' }]);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('no tasks eligible');
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('does not include exceeded tasks in /retry candidates', async () => {
    mocks.listAllTaskItems.mockReturnValue([exceededTask]);

    const notice = await runAssistantRetryCommand(options);

    expect(notice).toContain('no tasks eligible');
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('uses the exact selectable start ID and persists a confirmed failed-task requeue', async () => {
    setStartResponse('{"startOptionId":"restart:implement"}');
    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('pending again');
    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.resolveFailedTaskRetryStart).toHaveBeenCalledWith(expect.anything(), 'restart:implement');
    expect(mocks.confirm).toHaveBeenCalledWith(
      'Return this task to the queue?\nTask: fix-quint-diagnostics\nSummary: Fix diagnostics\nWorkflow: development\nStart position: Restart implement',
      false,
    );
    expect(mocks.persistFailedTaskRetry).toHaveBeenCalledWith(expect.objectContaining({
      task,
      projectDir: '/repo',
      startStep: undefined,
      restartPoint: { step: 'implement' },
    }));
    expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).toMatchObject({
      retryNote: expect.stringContaining('[Auto-requeue]'),
    });
    expect(mocks.persistFailedTaskRetry.mock.calls[0]?.[0]).not.toHaveProperty('revisedOrder');
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
    mocks.confirm.mockResolvedValue(false);

    await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(mocks.confirm).toHaveBeenCalledWith(
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
    mocks.confirm.mockResolvedValue(false);

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
  ])('does not confirm when task selection returns %s', async (_name, response, expected) => {
    mocks.listAllTaskItems.mockReturnValue([task, { ...task, name: 'another-task' }]);
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: { success: true, content: response },
      sessionId: undefined,
    });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice.toLowerCase()).toContain(expected);
    expect(mocks.confirm).not.toHaveBeenCalled();
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
    mocks.confirm.mockResolvedValue(false);

    const notice = await runAssistantRetryCommand({
      ...options,
      command: 'requeue',
      inlineText: 'Use the selected task and resume from its failure.',
    });

    expect(notice).toContain('not changed');
    expect(mocks.callAIWithRetry).toHaveBeenCalledTimes(2);
    const taskPrompt = JSON.parse(String(mocks.callAIWithRetry.mock.calls[0]?.[0])) as {
      stage: string;
      inlineInstruction: string;
      candidates: Array<{ name: string }>;
    };
    expect(taskPrompt.stage).toBe('task');
    expect(taskPrompt.inlineInstruction).toBe('Use the selected task and resume from its failure.');
    expect(taskPrompt.candidates.map((candidate) => candidate.name)).toEqual([
      'fix-quint-diagnostics',
      'another-task',
    ]);
    expect(mocks.prepareFailedTaskRetry).toHaveBeenCalledWith(task, '/repo');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it.each(['unknown-option', 'heading:review'])('rejects unavailable start option %s without confirmation', async (startOptionId) => {
    setStartResponse(JSON.stringify({ startOptionId }));

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('not available');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('returns to the conversation when the assistant cannot choose a start position', async () => {
    setStartResponse('{"startOptionId":null}');

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('could not identify');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('reports a provider failure without opening the confirmation prompt', async () => {
    mocks.callAIWithRetry.mockResolvedValueOnce({
      result: null,
      sessionId: undefined,
      error: 'provider unavailable',
    });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('provider unavailable');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
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
    mocks.confirm.mockResolvedValue(true);

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('pending again');
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('review'), false);
    expect(mocks.callAIWithRetry).not.toHaveBeenCalled();
    expect(mocks.requeueExceededTask).toHaveBeenCalledWith('long-running-task');
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });

  it('returns a notice when an exceeded task cannot be requeued after confirmation', async () => {
    mocks.listAllTaskItems.mockReturnValue([exceededTask]);
    mocks.confirm.mockResolvedValue(true);
    mocks.requeueExceededTask.mockImplementationOnce(() => {
      throw new Error('Task not found: long-running-task (exceeded)');
    });

    const notice = await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(notice).toContain('could not be prepared');
    expect(notice).toContain('Task not found: long-running-task (exceeded)');
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
    mocks.confirm.mockResolvedValue(false);

    await runAssistantRetryCommand({ ...options, command: 'requeue' });

    expect(mocks.confirm).toHaveBeenCalledWith(
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
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.selectOption).not.toHaveBeenCalled();
    expect(mocks.persistFailedTaskRetry).not.toHaveBeenCalled();
  });
});
