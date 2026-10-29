import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import type { TellableRunningTask } from '../features/tasks/liveIntervention.js';
import { getDisplayWidth } from '../shared/utils/text.js';
import { makeSessionContext } from './test-helpers.js';

function terminalTextWidth(text: string): number {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 1000 });
  const reader = createInterface({ input, output, terminal: true });
  reader.setPrompt('');
  reader.write(text);
  const { rows, cols } = reader.getCursorPos();
  reader.close();
  return rows * output.columns + cols;
}

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
  let savedStdoutColumns: number | undefined;
  let savedStdoutRows: number | undefined;
  let savedNoTty: string | undefined;
  let savedTouchTty: string | undefined;

  beforeEach(() => {
    savedStdinIsTTY = process.stdin.isTTY;
    savedStdoutIsTTY = process.stdout.isTTY;
    savedStdoutColumns = process.stdout.columns;
    savedStdoutRows = process.stdout.rows;
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
    Object.defineProperty(process.stdout, 'columns', { value: savedStdoutColumns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: savedStdoutRows, configurable: true });
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

  it('automatically confirms the only target and writes after confirmation', async () => {
    const notice = await runTellCommand({
      cwd: '/project',
      lang: 'en',
      inlineText: 'Skip Android support for this task.',
      history: [],
      sessionContext: makeSessionContext(),
      preferredRunSlug: target.runSlug,
    });

    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.not.stringContaining('Running tasks excluded from /tell'));
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
    expect(mockSelectOption).not.toHaveBeenCalled();
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
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports excluded tasks on single-target generation failure when excluded=%s', async (hasExcluded) => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target], excluded: hasExcluded ? ['local-task: not a worktree clone'] : [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'provider unavailable' });
    const notice = await runTellCommand({ cwd: '/project', lang: 'en', inlineText: 'Update this.', history: [], sessionContext: makeSessionContext() });
    expect(notice).toContain('provider unavailable');
    if (hasExcluded) expect(notice).toContain('local-task: not a worktree clone');
    else expect(notice).not.toContain('Running tasks excluded from /tell');
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports excluded tasks on AI-selected empty generation when excluded=%s', async (hasExcluded) => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: hasExcluded ? ['local-task: not a worktree clone'] : [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: JSON.stringify({ runSlug: alternateTarget.runSlug }) } })
      .mockResolvedValueOnce({ result: { success: true, content: '   ' } });
    const notice = await runTellCommand({ cwd: '/project', lang: 'en', inlineText: 'Update payments.', history: [], sessionContext: makeSessionContext() });
    expect(notice).toContain('generated');
    if (hasExcluded) expect(notice).toContain('local-task: not a worktree clone');
    else expect(notice).not.toContain('Running tasks excluded from /tell');
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('does not repeat excluded tasks after manual selection when generation fails', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: ['local-task: not a worktree clone'] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' })
      .mockResolvedValueOnce({ result: null, error: 'target unavailable' })
      .mockResolvedValueOnce({ result: null, error: 'provider unavailable' });
    mockSelectOption.mockResolvedValueOnce(alternateTarget.runSlug);
    const notice = await runTellCommand({ cwd: '/project', lang: 'en', inlineText: 'Update payments.', history: [], sessionContext: makeSessionContext() });
    expect(mockSelectOption).toHaveBeenCalledWith(expect.stringContaining('local-task: not a worktree clone'), expect.any(Array));
    expect(notice).toContain('provider unavailable');
    expect(notice).not.toContain('local-task: not a worktree clone');
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('keeps the referenced run as the initial choice but writes only the confirmed selection', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' }).mockResolvedValueOnce({ result: null, error: 'target unavailable' });
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
    expect(String(mockCallAIWithRetry.mock.calls.at(-1)?.[0])).toContain('payments\nAdd payment retries');
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project',
      alternateTarget.runSlug,
      'Generated standalone instruction.',
    );
    expect(notice).toContain('instruction #7');
  });

  it('identifies the selected recipient even when a different task is the last conversation topic', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' }).mockResolvedValueOnce({ result: null, error: 'target unavailable' });
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

  describe.each(['en', 'ja'] as const)('recipient selection failure in %s', (lang) => {
    it.each([false, true])('reports the selection reason without generating, confirming, or sending when preferred=%s', async (preferred) => {
      mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
      mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' }).mockResolvedValueOnce({ result: null, error: 'target unavailable' });
      const selector = preferred ? mockSelectOptionWithDefault : mockSelectOption;
      const reason = 'Interactive selection input exceeds 65536 byte limit';
      selector.mockRejectedValueOnce(new Error(reason));

      const notice = await runTellCommand({
        cwd: '/project', lang, inlineText: 'Add login audit.', history: [],
        sessionContext: makeSessionContext(),
        ...(preferred ? { preferredRunSlug: target.runSlug } : {}),
      });

      expect(notice).toContain(reason);
      expect(notice).toMatch(lang === 'en' ? /failed to select/i : /送信先選択に失敗/);
      expect(notice).toMatch(lang === 'en' ? /no instruction was sent/i : /送信されていません/);
      expect(selector).toHaveBeenCalledTimes(1);
      expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
      expect(mockConfirmWithCancel).not.toHaveBeenCalled();
      expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
    });
  });

  describe.each(['en', 'ja'] as const)('instruction confirmation failure in %s', (lang) => {
    it.each([false, true])('reports the confirmation reason without sending when preferred=%s', async (preferred) => {
      mockConfirmWithCancel.mockRejectedValueOnce(new Error('confirmation unavailable'));

      const notice = await runTellCommand({
        cwd: '/project', lang, inlineText: 'Add login audit.', history: [],
        sessionContext: makeSessionContext({ lang }),
        ...(preferred ? { preferredRunSlug: target.runSlug } : {}),
      });

      expect(mockSelectOption).not.toHaveBeenCalled();
      expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
      expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
      expect(mockConfirmWithCancel).toHaveBeenCalledOnce();
      expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(target.runSlug));
      expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Generated standalone instruction.'));
      expect(notice).toContain('confirmation unavailable');
      expect(notice).toMatch(lang === 'en' ? /was not sent/i : /送信されませんでした/);
      expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
    });
  });

  it('sanitizes the recipient selection failure reason', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' }).mockResolvedValueOnce({ result: null, error: 'target unavailable' });
    mockSelectOption.mockRejectedValueOnce(new Error('input\x1b[31m failed\n'));
    const notice = await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Add login audit.', history: [], sessionContext: makeSessionContext(),
    });
    expect(notice).toContain('input failed\\n');
    expect(notice).not.toContain('\x1b');
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not generate when recipient selection is cancelled with preferred=%s', async (preferred) => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' }).mockResolvedValueOnce({ result: null, error: 'target unavailable' });
    const selector = preferred ? mockSelectOptionWithDefault : mockSelectOption;
    selector.mockResolvedValueOnce(null);

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
      ...(preferred ? { preferredRunSlug: target.runSlug } : {}),
    });

    expect(notice).toContain('was not sent');
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it('selects the conversation topic with AI even when another run is referenced', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: JSON.stringify({ runSlug: alternateTarget.runSlug }) } });

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.',
      history: [{ role: 'user', content: 'For payments, retry declined charges.' }],
      sessionContext: makeSessionContext(), preferredRunSlug: target.runSlug,
    });

    const calls = mockCallAIWithRetry.mock.calls.slice(0, -1).flat().map(String).join(' ');
    expect(calls).toContain('For payments, retry declined charges.');
    expect(calls).toContain('payments-run');
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('payments-run'));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('review'));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Generated standalone instruction.'));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
    expect(mockCallAIWithRetry.mock.calls[0]?.[4]).toMatchObject({ sessionId: undefined, mcpServers: undefined, taskStateMcpServers: undefined, disableSessionRetry: true });
    expect(mockCallAIWithRetry.mock.calls[0]?.[5]).toMatchObject({ permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly', persistSession: false });
  });

  it('retries an invalid target response and accepts a valid second choice', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry
      .mockResolvedValueOnce({ result: { success: true, content: 'invalid JSON' } })
      .mockResolvedValueOnce({ result: { success: true, content: JSON.stringify({ runSlug: alternateTarget.runSlug }) } });

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(3);
    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(alternateTarget.runSlug));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
  });

  it('shows a reason after two target resolution exceptions with empty messages', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockRejectedValueOnce(new Error('')).mockRejectedValueOnce(new Error(''));
    mockSelectOption.mockResolvedValueOnce(null);

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
    expect(mockSelectOption).toHaveBeenCalledWith(expect.stringMatching(/conversation did not identify/i), expect.any(Array));
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'unknown candidate', response: { result: { success: true, content: JSON.stringify({ runSlug: 'unknown-run' }) } }, reason: /not among the candidates/i },
    { kind: 'provider failure', response: { result: null, error: 'target unavailable' }, reason: /target unavailable/i },
    { kind: 'undecided', response: { result: { success: true, content: '{"runSlug":null}' } }, reason: /conversation did not identify/i },
  ])('asks the user with a reason after two target resolution failures: $kind', async ({ response, reason }) => {
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    mockCallAIWithRetry.mockResolvedValueOnce(response).mockResolvedValueOnce(response);
    mockSelectOption.mockResolvedValue(alternateTarget.runSlug);

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.',
      history: [{ role: 'user', content: 'For payments, retry declined charges.' }],
      sessionContext: makeSessionContext(),
    });

    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(3);
    const [prompt, options] = mockSelectOption.mock.calls[0]!;
    expect(String(prompt)).toMatch(reason);
    expect(String(prompt)).not.toContain('Running tasks excluded from /tell');
    expect(options).toEqual(expect.arrayContaining([expect.objectContaining({ value: alternateTarget.runSlug })]));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('payments-run'));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
  });

  it.each([
    { lang: 'en', preferred: false, columns: 80 },
    { lang: 'en', preferred: true, columns: 30 },
    { lang: 'ja', preferred: false, columns: 30 },
    { lang: 'ja', preferred: true, columns: 80 },
  ] as const)('keeps a failure reason, selection prompt, and excluded count in a $columns-column $lang selector (preferred=$preferred)', async ({
    lang, preferred, columns,
  }) => {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const excluded = Array.from({ length: 25 }, (_, index) => `excluded-${index}: not a worktree clone`);
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' })
      .mockResolvedValueOnce({ result: null, error: 'target unavailable' });
    const selector = preferred ? mockSelectOptionWithDefault : mockSelectOption;
    selector.mockResolvedValueOnce(alternateTarget.runSlug);

    await runTellCommand({
      cwd: '/project', lang, inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
      ...(preferred ? { preferredRunSlug: alternateTarget.runSlug } : {}),
    });

    const prompt = String(selector.mock.calls[0]?.[0]);
    expect(prompt.split('\n')[0]).toContain(columns === 30 ? 'target unavai' : 'target unavailable');
    expect(prompt.split('\n')[1]).toContain(lang === 'en' ? 'Select the running task' : '実行中タスクを選択');
    expect(prompt).toContain('excluded-0');
    expect(prompt).toMatch(lang === 'en' ? /and \d+ more excluded tasks/ : /ほか \d+ 件の実行中タスクを除外/);
    expect(prompt).not.toContain(excluded[24]);
    const headerRows = 2 + [...prompt.split('\n'), '  (↑↓ to move, Enter to select)']
      .reduce((rows, line) => rows + Math.max(1, Math.ceil(terminalTextWidth(line) / columns)), 0);
    expect(headerRows + 7).toBeLessThanOrEqual(24);
    expect(selector).toHaveBeenCalledWith(prompt, expect.arrayContaining([
      expect.objectContaining({ value: target.runSlug }),
      expect.objectContaining({ value: alternateTarget.runSlug }),
    ]), ...(preferred ? [alternateTarget.runSlug] : []));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
  });

  it('keeps the failure reason, selection prompt, and a candidate visible in an 80x12 terminal', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 12, configurable: true });
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [target, alternateTarget],
      excluded: Array.from({ length: 25 }, (_, index) => `excluded-${index}: not a worktree clone`),
    });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' })
      .mockResolvedValueOnce({ result: null, error: 'target unavailable' });
    mockSelectOption.mockResolvedValueOnce(alternateTarget.runSlug);

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
    });

    const prompt = String(mockSelectOption.mock.calls[0]?.[0]);
    expect(prompt).toContain('target unavailable');
    expect(prompt).toContain('Select the running task');
    expect(prompt).not.toContain('Running tasks excluded from /tell');
    const headerRows = 2 + [...prompt.split('\n'), '  (↑↓ to move, Enter to select)']
      .reduce((rows, line) => rows + Math.max(1, Math.ceil(terminalTextWidth(line) / 80)), 0);
    expect(headerRows + 7).toBeLessThanOrEqual(12);
    expect(mockSelectOption).toHaveBeenCalledWith(prompt, expect.arrayContaining([
      expect.objectContaining({ value: target.runSlug }),
      expect.objectContaining({ value: alternateTarget.runSlug }),
    ]));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
  });

  it.each([
    { lang: 'en', preferred: false, source: 'provider', error: `\u001b[31mA\nB\t${'x'.repeat(240)}`, visibleReason: 'A\\nB\\t' },
    { lang: 'en', preferred: true, source: 'provider', error: `\u001b[31mA\nB\t${'x'.repeat(240)}`, visibleReason: 'A\\nB\\t' },
    { lang: 'ja', preferred: false, source: 'exception', error: `\u001b[31m異常\n詳細\t${'長'.repeat(240)}`, visibleReason: '異常\\n詳細\\t' },
    { lang: 'ja', preferred: true, source: 'exception', error: `\u001b[31m異常\n詳細\t${'長'.repeat(240)}`, visibleReason: '異常\\n詳細\\t' },
    { lang: 'en', preferred: false, source: 'provider', error: '😀'.repeat(100), visibleReason: '😀' },
    { lang: 'ja', preferred: true, source: 'exception', error: '😀'.repeat(100), visibleReason: '😀' },
  ] as const)('keeps the $lang failure header within terminal width and allows selection (preferred=$preferred)', async ({
    lang, preferred, source, error, visibleReason,
  }) => {
    const columns = 30;
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    mockInspectTellableRunningTasks.mockReturnValue({ tasks: [target, alternateTarget], excluded: [] });
    if (source === 'provider') {
      mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error })
        .mockResolvedValueOnce({ result: null, error });
    } else {
      mockCallAIWithRetry.mockRejectedValueOnce(new Error(error))
        .mockRejectedValueOnce(new Error(error));
    }
    const selector = preferred ? mockSelectOptionWithDefault : mockSelectOption;
    selector.mockResolvedValueOnce(alternateTarget.runSlug);

    await runTellCommand({
      cwd: '/project', lang, inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
      ...(preferred ? { preferredRunSlug: alternateTarget.runSlug } : {}),
    });

    const prompt = String(selector.mock.calls[0]?.[0]);
    const [failureLine, selectionLine] = prompt.split('\n');
    expect(getDisplayWidth(failureLine!)).toBeLessThanOrEqual(columns);
    expect(failureLine).toContain(visibleReason);
    expect(failureLine).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(selectionLine).toBeTruthy();
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(3);
    expect(selector).toHaveBeenCalledTimes(1);
    expect(preferred ? mockSelectOption : mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith(
      '/project', alternateTarget.runSlug, 'Generated standalone instruction.',
    );
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

  it('does not write when confirmation is cancelled with excluded running tasks', async () => {
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

    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('local-task: not a worktree clone'));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(target.runSlug));
    expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
    expect(notice).toContain('was not sent');
  });

  it('shows excluded tasks before confirming an AI-selected target', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [target, alternateTarget], excluded: ['local-task: not a worktree clone'],
    });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: JSON.stringify({ runSlug: alternateTarget.runSlug }) } });
    mockConfirmWithCancel.mockImplementationOnce(async () => {
      expect(mockIssueTellableRunningTask).not.toHaveBeenCalled();
      return { kind: 'value', value: true };
    });

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
    });

    expect(mockSelectOption).not.toHaveBeenCalled();
    expect(mockSelectOptionWithDefault).not.toHaveBeenCalled();
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('local-task: not a worktree clone'));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(alternateTarget.runSlug));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
  });

  it('shows excluded tasks in the manual selection after two failures', async () => {
    mockInspectTellableRunningTasks.mockReturnValue({
      tasks: [target, alternateTarget], excluded: ['local-task: not a worktree clone'],
    });
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, error: 'target unavailable' })
      .mockResolvedValueOnce({ result: null, error: 'target unavailable' });
    mockSelectOption.mockResolvedValueOnce(alternateTarget.runSlug);

    await runTellCommand({
      cwd: '/project', lang: 'en', inlineText: 'Apply this to payments.', history: [],
      sessionContext: makeSessionContext(),
    });

    expect(mockSelectOption).toHaveBeenCalledWith(expect.stringContaining('local-task: not a worktree clone'), expect.any(Array));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.not.stringContaining('local-task: not a worktree clone'));
    expect(mockIssueTellableRunningTask).toHaveBeenCalledWith('/project', alternateTarget.runSlug, 'Generated standalone instruction.');
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
    expect(notice).not.toContain('Running tasks excluded from /tell');
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
