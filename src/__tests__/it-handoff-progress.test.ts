import { closeSync, openSync } from 'node:fs';
import { format } from 'node:util';
import chalk from 'chalk';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import type { FailedTaskRetryPreparation } from '../features/tasks/taskRetryPreparation.js';
import type { AssistantRetryCommandOptions } from '../features/interactive/assistantRetryCommand.js';
import type { TellCommandOptions } from '../features/interactive/tellCommand.js';
import type { callAIWithRetry } from '../features/interactive/aiCaller.js';
import type { TellableRunningTask } from '../features/tasks/liveIntervention.js';
import type { StreamCallback, StreamEvent } from '../shared/types/provider.js';
import { getLabel, getLabelObject } from '../shared/i18n/index.js';
import { statusLine } from '../shared/ui/StatusLine.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';
import { makeSessionContext } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
  callAI: vi.fn<typeof callAIWithRetry>(),
  interactive: vi.fn(() => true),
  useTty: vi.fn(() => true),
  listTasks: vi.fn<() => TaskListItem[]>(),
  prepare: vi.fn(),
  startContext: vi.fn(),
  resolveStart: vi.fn(),
  persist: vi.fn(),
  requeueExceeded: vi.fn(),
  requeueTask: vi.fn(),
  loadWorkflow: vi.fn(),
  inspectTell: vi.fn(),
  issueTell: vi.fn(),
  confirm: vi.fn<typeof import('../shared/prompt/index.js').confirmWithCancel>(),
  select: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
}));

vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: mocks.callAI,
}));
vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/task/index.js')>()),
  TaskRunner: class {
    listAllTaskItems(): TaskListItem[] { return mocks.listTasks(); }
    requeueExceededTask(name: string): void { mocks.requeueExceeded(name); }
    requeueTask(...args: unknown[]): string { return mocks.requeueTask(...args); }
  },
}));
vi.mock('../features/tasks/taskRetryPreparation.js', () => ({
  prepareFailedTaskRetry: mocks.prepare,
  buildFailedTaskRetryStartContext: mocks.startContext,
  resolveFailedTaskRetryStart: mocks.resolveStart,
}));
vi.mock('../features/tasks/taskRetryPersistence.js', () => ({
  appendRetryNote: (old: string | undefined, next: string) => old ? `${old}\n\n${next}` : next,
  persistFailedTaskRetry: mocks.persist,
}));
vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({ assertReusableWorktreePath: vi.fn() }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  loadWorkflowByIdentifier: mocks.loadWorkflow,
}));
vi.mock('../features/tasks/liveIntervention.js', () => ({
  inspectTellableRunningTasks: mocks.inspectTell,
  issueTellableRunningTask: mocks.issueTell,
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  hasInteractiveTerminal: mocks.interactive,
}));
vi.mock('../shared/prompt/tty.js', () => ({
  resolveTtyPolicy: () => ({ useTty: mocks.useTty(), forceTouchTty: false }),
}));
vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  confirmWithCancel: mocks.confirm,
  selectOption: mocks.select,
}));

import { runAssistantRetryCommand } from '../features/interactive/assistantRetryCommand.js';
import { runTellCommand } from '../features/interactive/tellCommand.js';
import { withHandoffProgress } from '../features/interactive/handoffProgress.js';

type Stage = 'task' | 'start' | 'revision' | 'tell';
type Screen = readonly string[];
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u;
const stageLabels = {
  en: {
    task: /(?:select|choos).*task/iu,
    start: /(?:start|starting).*(?:position|point|step)|(?:select|choos).*start/iu,
    revision: /(?:revis|updat|rewrit).*(?:instruction|order)/iu,
    tell: /(?:compos|creat|generat|prepar).*(?:instruction|message)/iu,
  },
  ja: {
    task: /(?:タスク|候補).*選/iu,
    start: /開始.*(?:判断|選|決)/iu,
    revision: /指示書.*(?:改訂|更新|修正)/iu,
    tell: /指示文.*(?:作成|生成)/iu,
  },
} as const;

function failedTask(): TaskListItem {
  return {
    kind: 'failed', name: 'parser-repair', createdAt: '2026-10-09T00:00:00Z',
    filePath: '/repo/.takt/tasks.yaml', content: 'Repair the parser.', summary: 'Parser repair',
    worktreePath: '/repo/worktree', taskDir: '.takt/tasks/parser-repair', runSlug: 'failed-run',
    data: { task: 'Repair the parser.', workflow: 'development' },
    failure: { step: 'implement', error: 'Build failed' },
  };
}

function exceededTask(): TaskListItem {
  return {
    ...failedTask(), kind: 'exceeded', failure: undefined, exceededCurrentIteration: 8,
    data: { task: 'Repair the parser.', workflow: 'development', start_step: 'review' },
  };
}

function tellTarget(): TellableRunningTask {
  return {
    task: {
      name: 'parser-repair', summary: 'Parser repair', kind: 'running', status: 'running',
      createdAt: '2026-10-09T00:00:00Z', filePath: '/repo/.takt/tasks.yaml',
      runSlug: 'running-run', worktree: true, worktreePath: '/repo/worktree',
    },
    runSlug: 'running-run', worktreePath: '/repo/worktree',
    meta: {
      task: 'Repair the parser.', workflow: 'development', currentStep: 'implement',
      runSlug: 'running-run', status: 'running', startTime: '2026-10-09T00:00:00Z',
      runRoot: '/repo/worktree/.takt/runs/running-run',
      reportDirectory: '/repo/worktree/.takt/runs/running-run/reports',
      contextDirectory: '/repo/worktree/.takt/runs/running-run/context',
      logsDirectory: '/repo/worktree/.takt/runs/running-run/logs',
    },
  };
}

function retryOptions(command: 'retry' | 'requeue', lang: 'en' | 'ja', showProgress: boolean | undefined): AssistantRetryCommandOptions & { showProgress?: boolean } {
  return {
    cwd: '/repo', command, lang, inlineText: '', formalSpec: false,
    ...(showProgress === undefined ? {} : { showProgress }),
    history: [{ role: 'user', content: 'Repair the parser.' }],
    sessionContext: makeSessionContext({ lang }),
  };
}

function tellOptions(lang: 'en' | 'ja', showProgress: boolean | undefined): TellCommandOptions & { showProgress?: boolean } {
  return {
    cwd: '/repo', lang, inlineText: 'Repair the parser.',
    ...(showProgress === undefined ? {} : { showProgress }),
    history: [], sessionContext: makeSessionContext({ lang }),
  };
}

function assertProgress(screen: Screen, stage: Stage, lang: 'en' | 'ja', tail = ''): void {
  const rows = screen.filter((line) => line !== '');
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatch(SPINNER);
  const label = row.slice(2).split('  ')[0]!;
  expect(label).toMatch(stageLabels[lang][stage]);
  expect(Object.values(getLabelObject<Record<string, string>>('tui.ui', lang))).toContain(label);
  expect(row).toBe(`${row.charAt(0)} ${label}${tail === '' ? '' : `  ${tail}`}`);
  expect(row).not.toMatch(/\b(?:esc|cancel|interrupt)\b|中断|キャンセル/iu);
}

describe('handoff command progress on the released terminal', () => {
  let terminal: Terminal;
  let chunks: string[];
  let stderrChunks: string[];
  let consumed: number;
  let separateFd: number;
  let restoreStreams: () => void;
  let promptScreens: Array<{ kind: 'confirm' | 'select'; screen: Screen }>;
  let colorLevel: typeof chalk.level;

  async function screen(): Promise<Screen> {
    const delta = chunks.slice(consumed).join('').replace(/\r?\n/gu, '\r\n');
    consumed = chunks.length;
    if (delta !== '') await new Promise<void>((resolve) => terminal.write(delta, resolve));
    return Array.from({ length: terminal.rows }, (_, i) => (
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? ''
    ));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    statusLine.stop();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    colorLevel = chalk.level;
    chalk.level = 1;
    terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
    chunks = [];
    stderrChunks = [];
    consumed = 0;
    promptScreens = [];
    separateFd = openSync(process.execPath, 'r');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const stderrFd = Object.getOwnPropertyDescriptor(process.stderr, 'fd');
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'fd', { value: process.stdout.fd, configurable: true });
    process.stdout.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
    restoreStreams = () => {
      for (const [stream, key, descriptor] of [
        [process.stdout, 'isTTY', stdoutTTY], [process.stdout, 'columns', stdoutColumns],
        [process.stderr, 'isTTY', stderrTTY], [process.stderr, 'fd', stderrFd],
      ] as const) {
        if (descriptor === undefined) Reflect.deleteProperty(stream, key);
        else Object.defineProperty(stream, key, descriptor);
      }
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    };
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { process.stdout.write(`${format(...args)}\n`); });
    mocks.interactive.mockReturnValue(true);
    mocks.useTty.mockReturnValue(true);
    const task = failedTask();
    mocks.listTasks.mockReturnValue([task]);
    mocks.requeueTask.mockReturnValue(task.name);
    const preparation: FailedTaskRetryPreparation = {
      worktreePath: task.worktreePath!, failure: task.failure!, failedStep: 'implement',
      matchedRunSlug: 'failed-run', runMeta: null, previousWorkflow: 'development',
      previousOrderContent: '# Original order', resumePoint: undefined,
    };
    mocks.prepare.mockReturnValue(preparation);
    mocks.startContext.mockReturnValue({
      workflowName: 'development', workflowOverride: undefined,
      workflowConfig: { steps: [] }, options: {},
      startOptions: { options: [{ id: 'restart:implement', label: 'Restart implement', selectable: true }] },
    });
    mocks.resolveStart.mockReturnValue({ label: 'Restart implement', restartPoint: { step: 'implement' } });
    mocks.loadWorkflow.mockReturnValue(attachWorkflowOpaqueRef({
      name: 'development', initialStep: 'implement', maxSteps: 10,
      steps: ['implement', 'review'].map((name) => ({ name, personaDisplayName: name, instruction: name })),
    }, 'project:development'));
    const target = tellTarget();
    mocks.inspectTell.mockReturnValue({ tasks: [target], excluded: [] });
    mocks.issueTell.mockResolvedValue({ target, instructionId: 7 });
    mocks.confirm.mockImplementation(async () => {
      promptScreens.push({ kind: 'confirm', screen: await screen() });
      return { kind: 'value', value: true };
    });
    mocks.select.mockImplementation(async () => {
      promptScreens.push({ kind: 'select', screen: await screen() });
      return mocks.callAI.mock.calls.length === 0 ? target.runSlug : 'save_task';
    });
  });

  afterEach(() => {
    statusLine.stop();
    chalk.level = colorLevel;
    restoreStreams();
    vi.restoreAllMocks();
    vi.useRealTimers();
    terminal.dispose();
    closeSync(separateFd);
  });

  it('captures and clears the existing status line on the same terminal', async () => {
    statusLine.start('Working...');
    vi.advanceTimersByTime(120);
    const waiting = (await screen()).filter((line) => line !== '');
    statusLine.stop();
    const finished = (await screen()).filter((line) => line !== '');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatch(SPINNER);
    expect(waiting[0]?.slice(2)).toBe('Working...');
    expect(finished).toEqual([]);
  });

  it('does not register cancellation input while instruction generation is running', async () => {
    const listeners = () => [process.listenerCount('SIGINT'), process.stdin.listenerCount('data'), process.stdin.listenerCount('keypress')];
    const before = listeners();
    let during: number[] = [];
    let waiting: Screen = [];
    mocks.callAI.mockImplementation(async () => {
      during = listeners();
      waiting = await screen();
      return { result: { success: true, content: 'Complete instruction' }, sessionId: undefined };
    });
    await runTellCommand(tellOptions('en', true));
    assertProgress(waiting, 'tell', 'en');
    expect(during).toEqual(before);
    expect(listeners()).toEqual(before);
    expect(mocks.callAI.mock.calls[0]?.[5]?.outputMode).toBe('silent');
  });

  describe.each(['en', 'ja'] as const)('localized stages in %s', (lang) => {
    it.each([
      ['retry', 1], ['retry', 2], ['requeue', 1], ['requeue', 2],
    ] as const)('shows only the active /%s stage with %s candidates and clears it before confirmation', async (command, count) => {
      if (count === 2) mocks.listTasks.mockReturnValue([failedTask(), { ...failedTask(), name: 'another-task' }]);
      const observed: Array<{ stage: Stage; initial: Screen; screen: Screen }> = [];
      mocks.callAI.mockImplementation(async (prompt, _system, _tools, _cwd, _ctx, opts) => {
        const stage: Stage = prompt.startsWith('{') ? (JSON.parse(prompt) as { stage: 'task' | 'start' }).stage : 'revision';
        const initial = await screen();
        opts?.onStream?.({ type: 'text', data: { text: stage === 'revision' ? 'First line\nLatest revision' : '{"privateSelection":"json"}' } });
        vi.advanceTimersByTime(120);
        observed.push({ stage, initial, screen: await screen() });
        return { result: { success: true, content: stage === 'task' ? '{"taskName":"parser-repair"}' : stage === 'start' ? '{"startOptionId":"restart:implement"}' : '# Revised order' }, sessionId: undefined };
      });

      const notice = await runAssistantRetryCommand(retryOptions(command, lang, true));

      expect(observed.map((item) => item.stage)).toEqual([
        ...(count === 2 ? ['task'] : []), 'start', ...(command === 'retry' ? ['revision'] : []),
      ]);
      for (const item of observed) {
        assertProgress(item.initial, item.stage, lang);
        assertProgress(item.screen, item.stage, lang, item.stage === 'revision' ? 'Latest revision' : '');
      }
      for (const call of mocks.callAI.mock.calls) expect(call[5]).toMatchObject({ outputMode: 'silent', persistSession: false });
      for (const prompt of promptScreens) expect(prompt.screen.filter((line) => SPINNER.test(line))).toEqual([]);
      expect(promptScreens.map((item) => item.kind)).toEqual([command === 'retry' ? 'select' : 'confirm']);
      expect(notice).toBe(getLabel(command === 'retry' ? 'tui.errors.assistantRetrySaved' : 'tui.errors.assistantRetryRequeued', lang, { task: 'parser-repair' }));
      if (command === 'retry') expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ revisedOrder: { content: '# Revised order', lang } }));
      else expect(mocks.confirm.mock.calls[0]?.[0]).toBe(getLabel('tui.assistantRetry.requeueConfirm', lang, { task: 'parser-repair', summary: 'Parser repair', workflow: 'development', start: 'Restart implement' }));
    });

    it('shows the instruction-composition label only between recipient selection and confirmation', async () => {
      let initial: Screen = [];
      let waiting: Screen = [];
      mocks.callAI.mockImplementation(async (_prompt, _system, _tools, _cwd, _ctx, opts) => {
        initial = await screen();
        opts?.onStream?.({ type: 'text', data: { text: 'Old line\nLatest instruction' } });
        vi.advanceTimersByTime(120);
        waiting = await screen();
        return { result: { success: true, content: 'Complete instruction' }, sessionId: undefined };
      });

      const notice = await runTellCommand(tellOptions(lang, true));

      assertProgress(initial, 'tell', lang);
      assertProgress(waiting, 'tell', lang, 'Latest instruction');
      expect(promptScreens.map((item) => item.kind)).toEqual(['select', 'confirm']);
      expect(promptScreens.every((item) => item.screen.every((line) => !SPINNER.test(line)))).toBe(true);
      expect(mocks.confirm.mock.calls[0]?.[0]).toBe(getLabel('tui.tell.confirm', lang, { task: 'parser-repair', summary: 'Parser repair', workflow: 'development', step: 'implement', runSlug: 'running-run', content: 'Complete instruction' }));
      expect(mocks.issueTell).toHaveBeenCalledWith('/repo', 'running-run', 'Complete instruction');
      expect(notice).toBe(getLabel('tui.tell.sent', lang, { task: 'parser-repair', instructionId: '7' }));
      expect((await screen()).filter((line) => line !== '')).toEqual([]);
    });
  });

  it.each(['retry', 'tell'] as const)('updates /%s tails across split text and ignores non-text events on the same screen', async (command) => {
    const observed: Screen[] = [];
    const events: StreamEvent[] = [
      { type: 'text', data: { text: 'First line\n日本' } },
      { type: 'text', data: { text: '語の末尾' } },
      { type: 'text', data: { text: '\n' } },
      { type: 'text', data: { text: '\n' } },
      { type: 'text', data: { text: '短い行' } },
      { type: 'thinking', data: { thinking: 'Hidden thinking' } },
      { type: 'tool_use', data: { tool: 'Hidden tool', input: {}, id: 'tool-1' } },
      { type: 'tool_result', data: { content: 'Hidden tool result', isError: false } },
      { type: 'tool_output', data: { tool: 'Hidden tool', output: 'Hidden output' } },
      { type: 'result', data: { result: 'Hidden result', sessionId: 'test-session', success: true } },
    ];
    if (command === 'retry') mocks.callAI.mockResolvedValueOnce({ result: { success: true, content: '{"startOptionId":"restart:implement"}' }, sessionId: undefined });
    mocks.callAI.mockImplementation(async (_p, _s, _t, _c, _ctx, opts) => {
      for (const event of events) {
        opts?.onStream?.(event);
        vi.advanceTimersByTime(120);
        observed.push(await screen());
      }
      return { result: { success: true, content: '# Complete body\n\nPreserve every line.' }, sessionId: undefined };
    });

    if (command === 'retry') await runAssistantRetryCommand(retryOptions('retry', 'ja', true));
    else await runTellCommand(tellOptions('ja', true));

    const tails = ['日本', '日本語の末尾', '日本語の末尾', '', '短い行', '短い行', '短い行', '短い行', '短い行', '短い行'];
    observed.forEach((value, index) => assertProgress(value, command === 'retry' ? 'revision' : 'tell', 'ja', tails[index]!));
    if (command === 'retry') expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ revisedOrder: { content: '# Complete body\n\nPreserve every line.', lang: 'ja' } }));
    else expect(mocks.issueTell).toHaveBeenCalledWith('/repo', 'running-run', '# Complete body\n\nPreserve every line.');
  });

  it('truncates full-width text to one dim row and removes the previous longer tail', async () => {
    terminal.resize(48, 24);
    Object.defineProperty(process.stdout, 'columns', { value: 48, configurable: true });
    const observed: Screen[] = [];
    let dim = false;
    mocks.callAI.mockImplementation(async (_p, _s, _t, _c, _ctx, opts) => {
      opts?.onStream?.({ type: 'text', data: { text: '日本語'.repeat(40) } });
      vi.advanceTimersByTime(120);
      observed.push(await screen());
      const row = terminal.buffer.active.getLine(terminal.buffer.active.baseY)!;
      dim = Array.from({ length: terminal.cols }, (_, i) => row.getCell(i)!)
        .filter((cell) => cell.getChars().trim() !== '')
        .every((cell) => cell.isDim() !== 0);
      opts?.onStream?.({ type: 'text', data: { text: '\n短' } });
      vi.advanceTimersByTime(120);
      observed.push(await screen());
      return { result: { success: true, content: 'The complete, untruncated instruction.' }, sessionId: undefined };
    });

    await runTellCommand(tellOptions('ja', true));

    expect(observed[0]!.filter((line) => line !== '')).toHaveLength(1);
    expect(observed[0]![0]).toMatch(SPINNER);
    expect(observed[0]![0]).toContain('日本語');
    expect(dim).toBe(true);
    assertProgress(observed[1]!, 'tell', 'ja', '短');
    expect(mocks.issueTell).toHaveBeenCalledWith('/repo', 'running-run', 'The complete, untruncated instruction.');
  });

  it.each(['stdout', 'stderr'] as const)('preserves split %s logs and redraws one progress row after the newline', async (stream) => {
    const observed: Screen[] = [];
    mocks.callAI.mockImplementation(async () => {
      observed.push(await screen());
      process[stream].write('INFO split');
      observed.push(await screen());
      process[stream].write(' log\n');
      observed.push(await screen());
      return { result: { success: true, content: 'Complete instruction' }, sessionId: undefined };
    });

    await runTellCommand(tellOptions('en', true));

    assertProgress(observed[0]!, 'tell', 'en');
    expect(observed[1]!.filter((line) => line !== '')).toEqual(['INFO split']);
    expect(observed[2]!.filter((line) => line !== '')).toHaveLength(2);
    expect(observed[2]![0]).toBe('INFO split log');
    assertProgress([observed[2]![1]!], 'tell', 'en');
    expect((await screen()).filter((line) => line !== '')).toEqual(['INFO split log']);
  });

  it('keeps stderr on its separate destination while progress continues on stdout', async () => {
    Object.defineProperty(process.stderr, 'fd', { value: separateFd, configurable: true });
    process.stderr.write = ((chunk: unknown) => { stderrChunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let waiting: Screen = [];
    mocks.callAI.mockImplementation(async () => {
      process.stderr.write('DEBUG separate destination');
      waiting = await screen();
      return { result: { success: true, content: 'Complete instruction' }, sessionId: undefined };
    });

    await runTellCommand(tellOptions('en', true));

    assertProgress(waiting, 'tell', 'en');
    expect(stderrChunks.join('')).toBe('DEBUG separate destination');
    expect((await screen()).filter((line) => line !== '')).toEqual([]);
  });

  describe.each(['retry', 'requeue', 'tell'] as const)('/%s completion', (command) => {
    it.each(['success', 'null', 'unsuccessful', 'exception'] as const)('clears progress after %s and ignores late events', async (outcome) => {
      const observed: Screen[] = [];
      const callbacks: Array<StreamCallback | undefined> = [];
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      if (command === 'retry') mocks.callAI.mockResolvedValueOnce({ result: { success: true, content: '{"startOptionId":"restart:implement"}' }, sessionId: undefined });
      mocks.callAI.mockImplementation(async (_p, _s, _t, _c, _ctx, opts) => {
        callbacks.push(opts?.onStream);
        observed.push(await screen());
        opts?.onStream?.({ type: 'text', data: { text: 'Temporary tail' } });
        if (outcome === 'exception') throw new Error('Provider threw');
        if (outcome === 'null') return { result: null, sessionId: undefined, error: 'Provider unavailable' };
        return { result: { success: outcome === 'success', content: command === 'requeue' ? '{"startOptionId":null}' : 'Complete instruction' }, sessionId: undefined };
      });

      const notice = command === 'tell'
        ? await runTellCommand(tellOptions('en', true))
        : await runAssistantRetryCommand(retryOptions(command, 'en', true));
      const finished = await screen();
      for (const callback of callbacks) callback?.({ type: 'text', data: { text: '\nLate event' } });
      vi.advanceTimersByTime(120);
      const afterLateEvent = await screen();

      assertProgress(observed[0]!, command === 'tell' ? 'tell' : command === 'retry' ? 'revision' : 'start', 'en');
      expect(finished.filter((line) => SPINNER.test(line) || line.includes('Temporary tail'))).toEqual([]);
      expect(afterLateEvent).toEqual(finished);
      expect(vi.getTimerCount()).toBe(0);
      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
      expect(notice.length).toBeGreaterThan(0);
    });
  });

  it.each(['null', 'unsuccessful', 'exception'] as const)('shows task selection before an immediate %s result and cleans up', async (outcome) => {
    mocks.listTasks.mockReturnValue([failedTask(), { ...failedTask(), name: 'another-task' }]);
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    let waiting: Screen = [];
    mocks.callAI.mockImplementation(async () => {
      waiting = await screen();
      if (outcome === 'exception') throw new Error('Provider threw');
      if (outcome === 'null') return { result: null, sessionId: undefined, error: 'Provider unavailable' };
      return { result: { success: false, content: 'Selection failed' }, sessionId: undefined };
    });

    const notice = await runAssistantRetryCommand(retryOptions('retry', 'en', true));

    assertProgress(waiting, 'task', 'en');
    expect(mocks.callAI).toHaveBeenCalledOnce();
    expect(promptScreens).toEqual([]);
    expect((await screen()).filter((line) => line !== '')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.stdout.write).toBe(stdoutWrite);
    expect(process.stderr.write).toBe(stderrWrite);
    expect(notice.length).toBeGreaterThan(0);
  });

  it('propagates an initial render failure, restores writes, and leaves the next operation usable', async () => {
    const failure = new Error('Initial write failed');
    const write = vi.fn((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }).mockImplementationOnce(() => { throw failure; });
    process.stdout.write = write;
    const stderrWrite = process.stderr.write;
    const operation = vi.fn(async () => 'body');

    await expect(withHandoffProgress(true, 'composeTell', 'en', operation)).rejects.toBe(failure);

    expect(operation).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(write);
    expect(process.stderr.write).toBe(stderrWrite);
    expect(vi.getTimerCount()).toBe(0);
    expect((await screen()).filter((line) => line !== '')).toEqual([]);
    await withHandoffProgress(true, 'selectStart', 'ja', async () => {
      assertProgress(await screen(), 'start', 'ja');
      process.stdout.write('INFO next operation\n');
      const during = (await screen()).filter((line) => line !== '');
      expect(during).toHaveLength(2);
      expect(during[0]).toBe('INFO next operation');
      assertProgress([during[1]!], 'start', 'ja');
    });
    expect((await screen()).filter((line) => line !== '')).toEqual(['INFO next operation']);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.stdout.write).toBe(write);
    expect(process.stderr.write).toBe(stderrWrite);
  });

  it('shows the exceeded-task start decision only when an inline instruction requires AI', async () => {
    mocks.listTasks.mockReturnValue([exceededTask()]);
    let waiting: Screen = [];
    mocks.callAI.mockImplementation(async () => {
      waiting = await screen();
      return { result: { success: true, content: '{"startOptionId":"restart:0"}' }, sessionId: undefined };
    });
    await runAssistantRetryCommand({ ...retryOptions('requeue', 'en', true), inlineText: 'Restart implement.' });
    assertProgress(waiting, 'start', 'en');
    expect(mocks.requeueTask).toHaveBeenCalledOnce();
    expect(promptScreens[0]?.screen.filter((line) => SPINNER.test(line))).toEqual([]);

    mocks.callAI.mockClear();
    await runAssistantRetryCommand(retryOptions('requeue', 'en', true));
    expect(mocks.callAI).not.toHaveBeenCalled();
    expect(mocks.requeueExceeded).toHaveBeenCalledWith('parser-repair');
    expect((await screen()).filter((line) => line !== '')).toEqual([]);
  });

  it.each(['retry', 'requeue', 'tell'] as const)('preserves silent /%s behavior when progress is not requested', async (command) => {
    const observed: Screen[] = [];
    mocks.callAI.mockImplementation(async (_p, _s, _t, _c, _ctx, opts) => {
      opts?.onStream?.({ type: 'text', data: { text: 'Must remain silent' } });
      observed.push(await screen());
      return { result: { success: true, content: command === 'tell' ? 'Complete instruction' : '{"startOptionId":null}' }, sessionId: undefined };
    });
    if (command === 'tell') {
      await runTellCommand(tellOptions('en', undefined));
    } else {
      await runAssistantRetryCommand(retryOptions(command, 'en', undefined));
    }
    expect(observed).toHaveLength(1);
    expect(observed[0]!.filter((line) => line !== '')).toEqual([]);
    expect(mocks.callAI.mock.calls[0]?.[5]?.onStream).toBeUndefined();
  });

  describe.each(['retry', 'requeue', 'tell'] as const)('/%s terminal checks', (command) => {
    it.each(['non-interactive terminal', 'disabled TTY policy'] as const)('keeps progress and AI inactive with %s', async (condition) => {
      if (condition === 'non-interactive terminal') mocks.interactive.mockReturnValue(false);
      else mocks.useTty.mockReturnValue(false);
      const notice = command === 'tell'
        ? await runTellCommand(tellOptions('en', true))
        : await runAssistantRetryCommand(retryOptions(command, 'en', true));
      expect(mocks.callAI).not.toHaveBeenCalled();
      expect(promptScreens).toEqual([]);
      expect((await screen()).filter((line) => line !== '')).toEqual([]);
      expect(notice).toContain('interactive terminal');
    });
  });
});
