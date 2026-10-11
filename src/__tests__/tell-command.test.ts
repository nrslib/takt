import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TellableRunningTask } from '../features/tasks/liveIntervention.js';
import { makeSessionContext } from './test-helpers.js';

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
    vi.resetAllMocks();
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
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
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
      sessionContext: makeSessionContext(),
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
      'Generated standalone instruction.',
    );
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Generated standalone instruction.'));
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

  it.each(['en', 'ja'] as const)('renders a history-only prompt without an inline utterance section (%s)', async (lang) => {
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
    const system = String(mockCallAIWithRetry.mock.calls[0]?.[1]);
    expect(system).not.toMatch(/\{\{[^}]+\}\}/u);
    expect(system.split('\n').filter((line) => /^#{1,6}\s.*\/tell/u.test(line))).toEqual([]);
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', target.runSlug, 'Generated standalone instruction.');
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
      sessionContext: makeSessionContext(),
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
    expect(confirmation).toContain('Generated standalone instruction.');
    expect(String(mockCallAIWithRetry.mock.calls[0]?.[0])).toContain('payments\nAdd payment retries');
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      alternateTarget.runSlug,
      'Generated standalone instruction.',
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
    expect(system.trim().length).toBeGreaterThan(0);
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
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: longInstruction } });

    await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'それでお願いします',
      history: [],
      sessionContext: makeSessionContext(),
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
      sessionContext: makeSessionContext(),
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
      sessionContext: makeSessionContext(),
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
      sessionContext: makeSessionContext(),
    });

    expect(notice).toContain('target is no longer running');
  });

  describe.each(['en', 'ja'] as const)('inline utterance in %s', (lang) => {
    it.each([false, true])('formats the last utterance separately from history when history=%s', async (hasHistory) => {
      const note = lang === 'ja' ? 'それでお願いします' : 'That works for me.';
      const history = hasHistory
        ? [{ role: 'assistant' as const, content: 'Use iOS only and exclude Android.' }]
        : [];
      await runTellCommand({
        cwd: '/project', lang, inlineText: note, history,
        sessionContext: makeSessionContext({ lang, sessionId: 'chat-session', mcpServers: { chat: { command: 'chat-mcp' } } }),
      });

      expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
      const [prompt, system, tools, cwd, context, callOptions] = mockCallAIWithRetry.mock.calls[0]!;
      const heading = String(system).split('\n').filter((line) => /^#{1,6}\s.*\/tell/u.test(line));
      expect(heading).toHaveLength(1);
      expect(heading[0]).not.toMatch(/\/(?:go|retry|requeue)\b/u);
      if (lang === 'ja') expect(heading[0]).toMatch(/[\p{Script=Han}\p{Script=Hiragana}]/u);
      expect(String(system).split(note)).toHaveLength(2);
      expect(String(prompt)).not.toContain(note);
      if (hasHistory) expect(String(prompt)).toContain(history[0]!.content);
      expect(tools).toEqual([]);
      expect(cwd).toBe('/project');
      expect(context).toMatchObject({ sessionId: undefined, mcpServers: undefined, taskStateMcpServers: undefined });
      expect(callOptions).toMatchObject({ outputMode: 'silent', persistSession: false });
      expect(callOptions.onStream).toBeUndefined();
      expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Generated standalone instruction.'));
      expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', target.runSlug, 'Generated standalone instruction.');
    });
  });

  it.each(['', ' \t\n'])('rejects missing input before selection or generation: %j', async (inlineText) => {
    const notice = await runTellCommand({
      cwd: '/project', lang: 'en', inlineText,
      history: [{ role: 'user', content: ' \t' }], sessionContext: makeSessionContext(),
    });
    expect(notice.length).toBeGreaterThan(0);
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('rejects an inline utterance without provider context before selecting a target', async () => {
    const notice = await runTellCommand({ cwd: '/project', lang: 'en', inlineText: 'Add login audit.', history: [] });
    expect(notice).toContain('No provider context');
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each([
    { failure: 'null response', response: { result: null, error: 'provider unavailable' } },
    { failure: 'unsuccessful response', response: { result: { success: false, content: 'generation failed' } } },
    { failure: 'empty response', response: { result: { success: true, content: ' \n ' } } },
    { failure: 'exception', response: new Error('provider threw') },
  ])('sends nothing after inline formatting returns $failure', async ({ response }) => {
    if (response instanceof Error) mockCallAIWithRetry.mockRejectedValueOnce(response);
    else mockCallAIWithRetry.mockResolvedValueOnce(response);
    const notice = await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'That works for me.',
      history: [], sessionContext: makeSessionContext(),
    });
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
    expect(notice.length).toBeGreaterThan(0);
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });
});
