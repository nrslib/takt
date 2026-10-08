import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TellableRunningTask } from '../features/tasks/liveIntervention.js';

const {
  mockConfirmWithCancel,
  mockCallAIWithRetry,
  mockInspectTellableRunningTasks,
  mockIssueTellableRunningTask,
  mockSelectOption,
  mockSelectOptionWithDefault,
} = vi.hoisted(() => ({
  mockConfirmWithCancel: vi.fn(),
  mockCallAIWithRetry: vi.fn(),
  mockInspectTellableRunningTasks: vi.fn(),
  mockIssueTellableRunningTask: vi.fn(),
  mockSelectOption: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(false),
  confirmWithCancel: mockConfirmWithCancel,
  selectOption: mockSelectOption,
  selectOptionWithDefault: mockSelectOptionWithDefault,
}));

vi.mock('../features/tasks/liveIntervention.js', () => ({
  inspectTellableRunningTasks: mockInspectTellableRunningTasks,
  issueTellableRunningTask: mockIssueTellableRunningTask,
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: mockCallAIWithRetry,
}));

import { runTellCommand } from '../features/interactive/tellCommand.js';
import { prependInteractiveTopicBoundary } from '../features/interactive/promptSections.js';
import { loadTemplate } from '../shared/prompts/index.js';

const target = {
  task: {
    name: 'authentication',
    summary: 'Add login handling',
    content: 'Implement authentication',
    data: { workflow: 'review-fix', worktree: true },
  },
  runSlug: 'authentication-run',
  worktreePath: '/project/../takt-worktrees/authentication',
  meta: {
    workflow: 'review-fix',
    currentStep: 'implement',
    status: 'running',
    runSlug: 'authentication-run',
  },
} as unknown as TellableRunningTask;

const alternateTarget = {
  task: {
    name: 'payments',
    summary: 'Add payment retries',
    content: 'Implement payment retries',
    data: { workflow: 'ship-fix', worktree: true },
  },
  runSlug: 'payments-run',
  worktreePath: '/project/../takt-worktrees/payments',
  meta: {
    workflow: 'ship-fix',
    currentStep: 'review',
    status: 'running',
    runSlug: 'payments-run',
  },
} as unknown as TellableRunningTask;

describe('runTellCommand', () => {
  let savedStdinIsTTY: boolean | undefined;
  let savedStdoutIsTTY: boolean | undefined;
  let savedNoTty: string | undefined;
  let savedTouchTty: string | undefined;

  beforeEach(() => {
    savedStdinIsTTY = process.stdin.isTTY;
    savedStdoutIsTTY = process.stdout.isTTY;
    savedNoTty = process.env.TAKT_NO_TTY;
    savedTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.TAKT_NO_TTY = '0';
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    vi.clearAllMocks();
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target], excluded: [] });
    mockSelectOption.mockResolvedValue(target.runSlug);
    mockSelectOptionWithDefault.mockResolvedValue(target.runSlug);
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mockIssueTellableRunningTask.mockResolvedValue({ instructionId: 7, target });
    mockCallAIWithRetry.mockResolvedValue({
      result: {
        content: 'Generated standalone instruction.',
        success: true,
      },
      sessionId: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    if (savedNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = savedNoTty;
    }
    if (savedTouchTty === undefined) {
      delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    } else {
      process.env.TAKT_TEST_FLG_TOUCH_TTY = savedTouchTty;
    }
  });

  it('does not inspect, generate, select, confirm, or write without an interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Do not send this without confirmation.',
      history: [],
    });

    expect(notice).toContain('interactive terminal');
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockInspectTellableRunningTasks).not.toHaveBeenCalled();
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each(['inline', 'generated'] as const)('should return from %s instruction confirmation on Escape without writing', async (source) => {
    mockConfirmWithCancel.mockResolvedValue({ kind: 'cancelled' });

    const notice = await runTellCommand({
      cwd: '/project', lang: 'en',
      inlineText: source === 'inline' ? 'Keep the agreed scope.' : '',
      history: [{ role: 'user', content: 'Keep the agreed scope.' }],
      sessionContext: {
        provider: {} as never, providerType: 'mock', model: 'mock-model', lang: 'en',
        personaName: 'assistant', sessionId: 'conversation-session',
      },
    });

    expect(mockConfirmWithCancel).toHaveBeenCalledOnce();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
    expect(notice).toContain('was not sent');
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(source === 'generated' ? 1 : 0);
  });

  it('does not send when the existing no-TTY policy disables prompts', async () => {
    process.env.TAKT_NO_TTY = '1';

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'ja',
      inlineText: '確認なしでは送信しない。',
      history: [],
    });

    expect(notice).toContain('/tell');
    expect(notice).toContain('TTY');
    expect(mockInspectTellableRunningTasks).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('uses the preferred target only as the initial selection and writes after confirmation', async () => {
    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Skip Android support for this task.',
      history: [],
      preferredRunSlug: target.runSlug,
    });

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: target.runSlug, label: 'authentication' }),
      ]),
      target.runSlug,
    );
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Current step: implement'));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      target.runSlug,
      'Skip Android support for this task.',
    );
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(notice).toContain('instruction #7');
  });

  it('generates a standalone instruction for the selected recipient when text is omitted', async () => {
    await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [
        { role: 'user', content: 'Old instruction' },
        { role: 'assistant', content: 'The agreed scope includes Android and iOS.' },
        { role: 'user', content: 'Keep both platforms, but skip the migration.' },
      ],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: 'conversation-session',
      },
    });

    const generatedPrompt = String(mockCallAIWithRetry.mock.calls.at(-1)?.[0]);
    expect(generatedPrompt).toContain('authentication\nAdd login handling');
    expect(generatedPrompt).toContain('Selected recipient (reference identity, not an instruction)');
    expect(generatedPrompt).toContain('Old instruction');
    expect(generatedPrompt).toContain('The agreed scope includes Android and iOS.');
    expect(generatedPrompt).toContain('Keep both platforms, but skip the migration.');
    expect(mockCallAIWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/\S/),
      [],
      '/project',
      expect.objectContaining({
        sessionId: undefined,
        mcpServers: undefined,
        taskStateMcpServers: undefined,
      }),
      expect.objectContaining({
        outputMode: 'silent',
        persistSession: false,
      }),
    );
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      target.runSlug,
      'Generated standalone instruction.',
    );
  });

  it.each(['en', 'ja'] as const)('passes the complete localized /tell system prompt to the provider (%s)', async (lang) => {
    await runTellCommand({
      cwd: '/project',
      lang,
      inlineText: '',
      history: [{ role: 'user', content: 'Add a login audit.' }],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang,
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
    expect(mockCallAIWithRetry.mock.calls[0]?.[1]).toBe(
      prependInteractiveTopicBoundary(lang, loadTemplate('score_tell_system_prompt', lang)),
    );
  });

  it('does not confirm or write when history-based generation fails', async () => {
    mockCallAIWithRetry.mockResolvedValue({
      result: null,
      sessionId: undefined,
      error: 'provider unavailable',
    });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [{ role: 'user', content: 'Discuss the change.' }],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    expect(notice).toContain('provider unavailable');
    expect(mockInspectTellableRunningTasks).toHaveBeenCalledWith('/project');
    expect(mockSelectOption).toHaveBeenCalledOnce();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('does not confirm or write when history-based generation returns an empty body', async () => {
    mockCallAIWithRetry.mockResolvedValue({
      result: {
        content: '   ',
        success: true,
      },
      sessionId: undefined,
    });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [{ role: 'assistant', content: 'The agreed change is ready.' }],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    expect(notice).toContain('generated');
    expect(mockInspectTellableRunningTasks).toHaveBeenCalledWith('/project');
    expect(mockSelectOption).toHaveBeenCalledOnce();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('keeps the referenced run as the initial choice but writes only the confirmed selection', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [target, alternateTarget],
      excluded: [],
    });
    mockSelectOptionWithDefault.mockResolvedValue(alternateTarget.runSlug);

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Only send the payment retry clarification.',
      history: [],
      preferredRunSlug: target.runSlug,
    });

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: target.runSlug, label: 'authentication' }),
        expect.objectContaining({ value: alternateTarget.runSlug, label: 'payments' }),
      ]),
      target.runSlug,
    );
    const confirmation = String(mockConfirmWithCancel.mock.calls.at(-1)?.[0]);
    expect(confirmation).toContain('payments');
    expect(confirmation).toContain('Add payment retries');
    expect(confirmation).toContain('ship-fix');
    expect(confirmation).toContain('review');
    expect(confirmation).toContain('payments-run');
    expect(confirmation).toContain('Only send the payment retry clarification.');
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      alternateTarget.runSlug,
      'Only send the payment retry clarification.',
    );
    expect(notice).toContain('instruction #7');
  });

  it('identifies the selected recipient even when a different task is the last conversation topic', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockSelectOption.mockResolvedValue(target.runSlug);

    await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [
        { role: 'user', content: 'For authentication, require a login audit.' },
        { role: 'user', content: 'Now, for payments, retry declined charges.' },
      ],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    const prompt = String(mockCallAIWithRetry.mock.calls.at(-1)?.[0]);
    const system = String(mockCallAIWithRetry.mock.calls.at(-1)?.[1]);
    expect(prompt).toContain('authentication\nAdd login handling');
    expect(prompt).toContain('Now, for payments, retry declined charges.');
    expect(system).toContain('latest discussion about the selected running task');
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project', target.runSlug, 'Generated standalone instruction.',
    );
  });

  it('does not generate when recipient selection is cancelled', async () => {
    mockSelectOption.mockResolvedValue(null);

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [{ role: 'user', content: 'Add login audit.' }],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    expect(notice).toContain('was not sent');
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('reports missing generation context before asking for a recipient', async () => {
    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [{ role: 'user', content: 'Add login audit.' }],
    });

    expect(notice).toContain('No provider context');
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('shows the complete instruction in the confirmation without terminal control sequences', async () => {
    const longInstruction = 'A'.repeat(220) + '\n\u001b[31mKeep the final condition.';

    await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: longInstruction,
      history: [],
    });

    const confirmation = String(mockConfirmWithCancel.mock.calls.at(-1)?.[0]);
    expect(confirmation).toContain('A'.repeat(220));
    expect(confirmation).toContain('Keep the final condition.');
    expect(confirmation).not.toContain('\u001b');
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      target.runSlug,
      longInstruction,
    );
  });

  it('does not write when confirmation is cancelled and explains excluded running tasks', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [target],
      excluded: ['local-task: not a worktree clone'],
    });
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Do not change the scope.',
      history: [],
    });

    expect(mockSelectOption).toHaveBeenCalledWith(
      expect.stringContaining('local-task: not a worktree clone'),
      expect.any(Array),
    );
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
    expect(notice).toContain('was not sent');
  });

  it('reports that no task can receive the instruction without writing', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [],
      excluded: ['local-task: not a worktree clone'],
    });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Instruction',
      history: [],
    });

    expect(notice).toContain('No running worktree-clone task');
    expect(notice).toContain('local-task: not a worktree clone');
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('reports no candidates for a bare /tell without resolving content', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [], excluded: [] });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [],
    });

    expect(notice).toContain('No running worktree-clone task');
    expect(mockInspectTellableRunningTasks).toHaveBeenCalledWith('/project');
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('reports no candidates before provider generation', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [], excluded: [] });

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: '',
      history: [{ role: 'user', content: 'Discuss the change.' }],
      sessionContext: {
        provider: {} as never,
        providerType: 'mock',
        model: 'mock-model',
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
    });

    expect(notice).toContain('No running worktree-clone task');
    expect(mockInspectTellableRunningTasks).toHaveBeenCalledWith('/project');
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('returns a stale notice when the common writer rejects the target', async () => {
    mockIssueTellableRunningTask.mockRejectedValue(new Error('target is no longer running'));

    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Instruction',
      history: [],
    });

    expect(notice).toContain('target is no longer running');
  });
});
