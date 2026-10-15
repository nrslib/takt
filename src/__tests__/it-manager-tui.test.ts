const failureNotice = vi.hoisted(() => vi.fn());
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: failureNotice }));
import { cleanup,render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { createElement,Profiler,type ComponentProps } from 'react';
import stringWidth from 'string-width';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import * as savedEvents from '../features/manager/savedEvents.js';
import { toDisplayText } from '../features/tui/displayText.js';
import * as workspaceRegistry from '../infra/config/global/workspaceRegistry.js';
import type { Goal, ManagerGoalSummary } from '../infra/goals/schema.js';
import { GoalCreateInputSchema,GoalSchema } from '../infra/goals/schema.js';
import { createGoal } from '../infra/goals/service.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../infra/goals/service.js', () => ({ createGoal: vi.fn() }));
const memory = vi.hoisted(() => ({ goals: vi.fn(() => [] as Goal[]) }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { async list() { return { goals: memory.goals(), errors: [] }; } async get(id: string) { return { ...goalRecord(), id }; } } }));
const inbox = vi.hoisted(() => ({ read: vi.fn(() => [] as unknown[]), remove: vi.fn() }));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: inbox.read, deleteManagerEvent: inbox.remove, saveManagerEvent: vi.fn(), deleteGoalEvents: vi.fn() }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));
const startupDoubles = vi.hoisted(() => ({ flush: vi.fn(async () => {}) }));
vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return { ...original, useApp: () => ({ ...original.useApp(), waitUntilRenderFlush: startupDoubles.flush }) };
});

const cwd = '/test/manager-repository';
const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'], constraints: ['mock provider のみ'], };
const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力', '通知'], acceptanceCriteria: ['JSONを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main', constraints: [], };
const ENTER = '\r';
const UP = '\x1b[A';
const LONG_TEXT = `${'長い貼り付け本文を確認してください。'.repeat(80)}末尾の確認`;

function response(summary: typeof summaryA | null) {
  const structuredOutput = { message: 'Please review the summary.', summary };
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify(structuredOutput), structuredOutput };
}

function mount(lang: 'ja' | 'en' = 'en', startup?: ComponentProps<typeof ManagerView>['startup'], assignment?: ComponentProps<typeof ManagerView>['assignment']) {
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  const register = vi.mocked(createGoal);
  register.mockImplementation(async ({ cwd: _cwd, ...input }) => ({ ...goalRecord(), ...input }));
  const session = createManagerConversationSession({
    cwd, assignment,
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang, provider: makeProvider({ supportsStructuredOutput: true, setup: () => ({ call }) }) },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
    },
  });
  const onExit = vi.fn();
  const commits = vi.fn();
  const app = render(createElement(Profiler, { id: 'manager', onRender: commits },
    createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit, startup, assignment })));
  return { app, call, register, session, lang, onExit, commits };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function promptFrame(context: ReturnType<typeof mount>): string {
  const frame = context.app.lastFrame()!;
  return frame.slice(frame.lastIndexOf('╭'));
}

function queuedFrame(context: ReturnType<typeof mount>): string | undefined {
  return context.app.lastFrame()?.match(/╭[\s\S]*?╰[^\n]*/gu)
    ?.find((frame) => /\n│\s*(?:送信待ち|queued messages|pending messages)\s*:\s*\d+/iu.test(frame));
}

function waitFor(assertions: () => void): Promise<void> {
  return vi.waitFor(assertions, { timeout: 10_000 });
}

async function typeAndSubmit(context: ReturnType<typeof mount>, text: string): Promise<void> {
  context.app.stdin.write(text);
  await waitFor(() => expect(promptFrame(context)).toContain(text));
  context.app.stdin.write(ENTER);
  await waitFor(() => {
    expect(promptFrame(context)).toMatch(/Discuss your goal|Enter your answer|ゴールを相談してください|回答を入力してください/u);
    expect(promptFrame(context)).not.toContain(text);
  });
}

async function send(context: ReturnType<typeof mount>, text: string, summary: ManagerGoalSummary) {
  const { app, call, session } = context;
  const before = call.mock.calls.length;
  app.stdin.write(text);
  await waitFor(() => expect(promptFrame(context)).toContain(text));
  app.stdin.write(ENTER);
  await waitFor(() => {
    expect(call).toHaveBeenCalledTimes(before + 1);
    expect(session.getPendingSummary()?.summary).toEqual(summary);
    const frame = app.lastFrame();
    expect(queuedFrame(context)).toBeUndefined();
    expect(promptFrame(context)).toContain(context.lang === 'ja' ? 'ゴールを相談してください' : 'Discuss your goal');
    expect(frame).toContain(summary.objective);
    expect(frame).toContain(context.lang === 'ja' ? '範囲外:' : 'Out of scope:');
    expect(frame).toContain(context.lang === 'ja' ? '受け入れ条件:' : 'Acceptance criteria:');
    for (const item of [...summary.outOfScope, ...summary.acceptanceCriteria, ...summary.constraints]) {
      expect(frame).toContain(`- ${toDisplayText(item).split('\n')[0]}`);
    }
    if (summary.startBranch !== undefined) expect(frame).toContain(`startBranch: ${summary.startBranch}`);
    if (summary.integrationBranch !== undefined) expect(frame).toContain(`integrationBranch: ${summary.integrationBranch}`);
  });
}

async function approve(context: ReturnType<typeof mount>, summary: ManagerGoalSummary) {
  const { app, register } = context;
  expect(register).not.toHaveBeenCalled();

  app.stdin.write(UP);
  app.stdin.write(ENTER);

  await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summary }));
  const request = GoalCreateInputSchema.parse(register.mock.calls[0]![0]);
  expect(request).toMatchObject({ cwd, ...summary });
  const registered = GoalSchema.parse(await register.mock.results[0]!.value);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(registered.id);
    expect(app.lastFrame()).toContain(registered.branch);
    expect(app.lastFrame()).not.toContain(context.lang === 'ja' ? '処理中' : 'Working');
    expect(queuedFrame(context)).toBeUndefined();
  });
}

beforeEach(() => { vi.clearAllMocks(); failureNotice.mockReset(); memory.goals.mockReturnValue([]); inbox.read.mockReturnValue([]); startupDoubles.flush.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('manager TUI human approval', () => {
  it('shows the draft and its cursor during a turn and keeps the draft after completion in the same screen', async () => {
    const turn = deferred<ReturnType<typeof response>>();
    const originalChalkLevel = chalk.level;
    chalk.level = 1;
    try {
      const context = mount();
      context.call.mockReturnValueOnce(turn.promise);
      try {
        await typeAndSubmit(context, 'first request');
        await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
        context.app.stdin.write('unsent draft');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('unsent draft');
          expect(prompt).toContain('unsent draft\x1b[7m \x1b[27m');
        });
        context.app.stdin.write('\x1b[D');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('unsent draft');
          expect(prompt).toContain('unsent draf\x1b[7mt\x1b[27m');
        });

        turn.resolve(response(null));
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          expect(stripVTControlCharacters(frame)).not.toContain('Working');
          expect(stripVTControlCharacters(frame.slice(frame.lastIndexOf('╭')))).toContain('unsent draft');
        });
        expect(context.call).toHaveBeenCalledOnce();
      } finally {
        context.app.unmount();
        turn.resolve(response(null));
        await context.session.close();
      }
    } finally {
      chalk.level = originalChalkLevel;
    }
  });

  it.each([
    { label: 'without a summary', summary: null },
    { label: 'with a summary', summary: summaryA },
  ])('displays queued messages and their count and sends them one at a time in FIFO order $label', async ({ summary }) => {
    const turns = Array.from({ length: 3 }, () => deferred<ReturnType<typeof response>>());
    const context = mount('ja');
    for (const turn of turns) context.call.mockReturnValueOnce(turn.promise);
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      for (const [index, text] of ['second request', 'third request'].entries()) {
        await typeAndSubmit(context, text);
        await waitFor(() => {
          expect(queuedFrame(context)).toContain(text);
          expect(queuedFrame(context)).toMatch(new RegExp(`(?:送信待ち|queued|pending messages)[^\\n]*${index + 1}`, 'iu'));
          expect(promptFrame(context)).toContain('ゴールを相談してください');
        });
        expect(context.call).toHaveBeenCalledOnce();
      }
      expect(queuedFrame(context)!.indexOf('second request')).toBeLessThan(queuedFrame(context)!.indexOf('third request'));
      context.app.stdin.write('unsent while queued');
      await waitFor(() => expect(promptFrame(context)).toContain('unsent while queued'));

      turns[0]!.resolve(response(summary));
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(2));
      expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request']);
      await waitFor(() => {
        expect(queuedFrame(context)).toMatch(/(?:送信待ち|queued|pending messages)[^\n]*1/iu);
        expect(queuedFrame(context)).toContain('third request');
        expect(queuedFrame(context)).not.toContain('second request');
      });
      expect(context.call).toHaveBeenCalledTimes(2);
      expect(promptFrame(context)).toContain('unsent while queued');

      turns[1]!.resolve(response(null));
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(3));
      expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request', 'third request']);
      turns[2]!.resolve(response(null));
      await waitFor(() => {
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request', 'third request']);
        expect(context.app.lastFrame()).not.toContain('処理中');
        expect(queuedFrame(context)).toBeUndefined();
        expect(promptFrame(context)).toContain('unsent while queued');
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      for (const turn of turns) turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('continues draining queued messages in FIFO order after a queued provider call fails', async () => {
    const turns = Array.from({ length: 4 }, () => deferred<ReturnType<typeof response>>());
    const context = mount();
    for (const turn of turns) context.call.mockReturnValueOnce(turn.promise);
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      for (const text of ['second request', 'third request', 'fourth request']) {
        await typeAndSubmit(context, text);
        await waitFor(() => expect(queuedFrame(context)).toContain(text));
      }
      expect(context.call).toHaveBeenCalledOnce();
      expect(queuedFrame(context)).toContain('Queued messages: 3');

      turns[0]!.resolve(response(null));
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(2));
      expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request']);
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('third request');
        expect(queuedFrame(context)).toContain('fourth request');
        expect(queuedFrame(context)).not.toContain('second request');
      });
      expect(context.call).toHaveBeenCalledTimes(2);

      turns[1]!.reject(new Error('provider failed'));
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(3));
      expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request', 'third request']);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('provider failed');
        expect(queuedFrame(context)).toContain('Queued messages: 1');
        expect(queuedFrame(context)).toContain('fourth request');
        expect(queuedFrame(context)).not.toContain('third request');
      });
      expect(context.call).toHaveBeenCalledTimes(3);

      turns[2]!.resolve(response(null));
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(4));
      expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'second request', 'third request', 'fourth request']);
      turns[3]!.resolve(response(null));
      await waitFor(() => {
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.call).toHaveBeenCalledTimes(4);
      });
    } finally {
      context.app.unmount();
      for (const turn of turns) turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('aborts the active turn with Esc and never sends discarded queued messages after completion', async () => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      const signal = context.call.mock.calls[0]![1].abortSignal!;
      await typeAndSubmit(context, 'discard second');
      await typeAndSubmit(context, 'discard third');
      await waitFor(() => expect(queuedFrame(context)).toContain('discard third'));

      context.app.stdin.write('\x1b[27u');
      await waitFor(() => expect(signal.aborted).toBe(true));
      expect(context.call).toHaveBeenCalledOnce();
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Conversation interrupted');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      await typeAndSubmit(context, 'fresh request');
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Please review the summary.');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'fresh request']);
        expect(queuedFrame(context)).toBeUndefined();
      });
    } finally {
      context.app.unmount();
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('exits on Ctrl+C during a turn and does not send its queued message', async () => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise);
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'queued before exit');
      await waitFor(() => expect(queuedFrame(context)).toContain('queued before exit'));
      const signal = context.call.mock.calls[0]![1].abortSignal!;
      context.app.stdin.write('\x03');
      await waitFor(() => expect(context.onExit).toHaveBeenCalledOnce());
      expect(signal.aborted).toBe(true);
      turn.resolve(response(null));
      await context.session.close();
      expect(context.call).toHaveBeenCalledOnce();
    } finally {
      context.app.unmount();
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('keeps Shift+Enter as a newline while a turn is running', async () => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      context.app.stdin.write('line one');
      context.app.stdin.write('\x1b[13;2u');
      context.app.stdin.write('line two');
      await waitFor(() => {
        expect(promptFrame(context)).toContain('line one');
        expect(promptFrame(context)).toContain('line two');
      });
      expect(context.call).toHaveBeenCalledOnce();
      expect(queuedFrame(context)).toBeUndefined();
      turn.resolve(response(null));
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls[1]![0]).toBe('line one\nline two');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
    } finally {
      context.app.unmount();
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it.each(['separate chunks', 'one bracketed paste chunk', 'one unbracketed chunk'] as const)('sends a long paste with one immediate Enter and clears the input: %s', async (delivery) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    const text = LONG_TEXT;
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      if (delivery === 'separate chunks') {
        context.app.stdin.write(text);
        context.app.stdin.write(ENTER);
      } else if (delivery === 'one bracketed paste chunk') context.app.stdin.write(`\x1b[200~${text}\x1b[201~${ENTER}`);
      else {
        context.app.stdin.write(`${text}${ENTER}`);
        context.app.stdin.write(ENTER);
      }

      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('末尾の確認');
        expect(context.call).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object));
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('末尾の確認');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      context.app.stdin.write(ENTER);
      await context.session.close();
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['separate chunks', 'one unbracketed chunk', 'one bracketed paste chunk', 'body CR before separate Enter'] as const)('sends a long free-text answer once with a separate Enter without sending it as conversation: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Where should the output go?',
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], goals: [], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved' });
    const text = `${'詳細な回答を保存してください。'.repeat(80)}回答の末尾`;
    try {
      await typeAndSubmit(context, `/answer ${target.question.id}`);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Enter your answer');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      if (delivery === 'separate chunks') {
        context.app.stdin.write(text);
        context.app.stdin.write(ENTER);
      } else if (delivery === 'one unbracketed chunk') {
        context.app.stdin.write(`${text}${ENTER}`);
        context.app.stdin.write(ENTER);
      } else if (delivery === 'one bracketed paste chunk') context.app.stdin.write(`\x1b[200~${text}\x1b[201~${ENTER}`);
      else {
        context.app.stdin.write(`${text}\r`);
        await waitFor(() => expect(promptFrame(context)).toContain('回答の末尾'));
        expect(answer).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        expect(queuedFrame(context)).toBeUndefined();
        context.app.stdin.write(ENTER);
      }
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('回答の末尾');
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, questionId: target.question.id, text, abortSignal: expect.any(AbortSignal),
        });
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('回答の末尾');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['plain text without Enter', 'unbracketed body containing CR', 'bracketed paste containing CR'] as const)('keeps a long draft unsent until an outside Enter: %s', async (delivery) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write(delivery === 'plain text without Enter' ? LONG_TEXT
        : delivery === 'unbracketed body containing CR' ? `${LONG_TEXT}\r` : `\x1b[200~${LONG_TEXT}\r\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();

      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith(LONG_TEXT, expect.any(Object));
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('末尾の確認');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('accepts the known limitation that a body CR after an embedded paste end marker can submit the draft', async () => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write('\x1b[200~確認\x1b[201~');
      await waitFor(() => expect(promptFrame(context)).toContain('確認'));
      expect(context.call).not.toHaveBeenCalled();
      // 本文中の終了マーカーで貼り付けが閉じると、後続の単独CRはEnterと区別できない。
      context.app.stdin.write('してください');
      context.app.stdin.write('\r');
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith('確認してください', expect.any(Object));
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(promptFrame(context)).not.toContain('確認してください');
      context.app.stdin.write(ENTER);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('does not execute a pasted pause command before a separate Enter', async () => {
    const context = mount();
    const pause = vi.spyOn(context.session, 'pauseGoal').mockResolvedValue({ kind: 'reply', message: 'Goal paused' });
    const command = `/pause ${goalRecord().id}`;
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write(`${command}\r`);
      await waitFor(() => expect(promptFrame(context)).toContain(command));
      expect(pause).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();

      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(context.app.lastFrame()).toContain('Goal paused');
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(pause).toHaveBeenCalledExactlyOnceWith({ goalId: goalRecord().id, abortSignal: expect.any(AbortSignal) });
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  describe.each(['turn', 'startup', 'registration'] as const)('long input during %s', (state) => {
    it.each([
      { submitBeforeCompletion: false },
      { submitBeforeCompletion: true },
    ])('keeps body CR unsent and submits once with a separate Enter: $submitBeforeCompletion', async ({ submitBeforeCompletion }) => {
      const completion = deferred<void>();
      const startup = state === 'startup' ? { run: vi.fn(async () => { await completion.promise; return []; }), fail: vi.fn() } : undefined;
      const context = mount('en', startup);
      try {
        if (state === 'turn') {
          context.call.mockImplementationOnce(async () => { await completion.promise; return response(null); });
          await typeAndSubmit(context, 'first request');
          await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
        } else if (state === 'registration') {
          context.register.mockImplementationOnce(async ({ cwd: _cwd, ...input }) => {
            await completion.promise;
            return { ...goalRecord(), ...input };
          });
          await send(context, 'CSV出力を追加したい', summaryA);
          context.app.stdin.write(UP);
          context.app.stdin.write(ENTER);
          await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
        } else await waitFor(() => expect(startup!.run).toHaveBeenCalledOnce());
        context.call.mockResolvedValue(response(null));
        const before = context.call.mock.calls.map(([text]) => text);
        const text = LONG_TEXT;

        context.app.stdin.write(`${LONG_TEXT}\r`);
        await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(before);
        expect(queuedFrame(context)).toBeUndefined();

        if (submitBeforeCompletion) {
          context.app.stdin.write(ENTER);
          await waitFor(() => {
            expect(queuedFrame(context)).toContain('Queued messages: 1');
            expect(queuedFrame(context)).toContain('末尾の確認');
            expect(promptFrame(context)).toContain('Discuss your goal');
          });
          expect(context.call.mock.calls.map(([text]) => text)).toEqual(before);
        }

        completion.resolve();
        if (!submitBeforeCompletion) {
          await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
          expect(promptFrame(context)).toContain('末尾の確認');
          expect(queuedFrame(context)).toBeUndefined();
          expect(context.call.mock.calls.map(([text]) => text)).toEqual(before);
          context.app.stdin.write(ENTER);
        }
        await waitFor(() => {
          expect(context.call.mock.calls.map(([prompt]) => prompt)).toEqual([...before, text]);
          expect(context.app.lastFrame()).not.toContain('Working');
          expect(promptFrame(context)).toContain('Discuss your goal');
          expect(queuedFrame(context)).toBeUndefined();
          expect(promptFrame(context)).not.toContain('末尾の確認');
        });
        expect(context.call).toHaveBeenCalledTimes(before.length + 1);
      } finally {
        context.app.unmount();
        completion.resolve();
        await context.session.close();
      }
    });
  });

  it.each(['one unbracketed chunk', 'bracketed paste followed immediately by Enter'] as const)('dismisses a selected summary and submits the pasted conversation: %s', async (delivery) => {
    const context = mount();
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.call.mockResolvedValue(response(null));
      if (delivery === 'one unbracketed chunk') {
        context.app.stdin.write(`${LONG_TEXT}${ENTER}`);
        await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
        expect(context.call).toHaveBeenCalledOnce();
        expect(context.register).not.toHaveBeenCalled();
        expect(queuedFrame(context)).toBeUndefined();
        context.app.stdin.write(ENTER);
      } else context.app.stdin.write(`\x1b[200~${LONG_TEXT}\r\x1b[201~${ENTER}`);

      await waitFor(() => {
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['CSV出力を追加したい', LONG_TEXT]);
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('末尾の確認');
        expect(context.session.getPendingSummary()).toBeNull();
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['one unbracketed chunk', 'bracketed paste containing CR'] as const)('keeps abort confirmation active when it receives a long pasted submission: %s', async (delivery) => {
    const context = mount();
    const abort = vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Goal aborted' });
    try {
      await typeAndSubmit(context, `/abort ${goalRecord().id}`);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      context.app.stdin.write(UP);
      context.app.stdin.write(delivery === 'one unbracketed chunk' ? `${LONG_TEXT}${ENTER}` : `\x1b[200~${LONG_TEXT}\r\x1b[201~`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
      expect(abort).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();
      expect(promptFrame(context)).not.toContain('末尾の確認');

      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(abort).toHaveBeenCalledExactlyOnceWith({ goalId: goalRecord().id, abortSignal: expect.any(AbortSignal) });
        expect(context.app.lastFrame()).toContain('Goal aborted');
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['selected option', 'plain text without Enter', 'one unbracketed chunk', 'bracketed paste containing CR'] as const)('routes selected options and pasted free text to the question: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], goals: [], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved' });
    try {
      await typeAndSubmit(context, `/answer ${target.question.id}`);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Free text');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      if (delivery === 'selected option') context.app.stdin.write(ENTER);
      else {
        context.app.stdin.write(delivery === 'plain text without Enter' ? LONG_TEXT
          : delivery === 'one unbracketed chunk' ? `${LONG_TEXT}\r`
            : `\x1b[200~${LONG_TEXT}\r\x1b[201~`);
        await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
        expect(answer).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        context.app.stdin.write(ENTER);
      }

      await waitFor(() => {
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, questionId: target.question.id,
          text: delivery === 'selected option' ? 'CSV' : LONG_TEXT,
          abortSignal: expect.any(AbortSignal),
        });
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('末尾の確認');
        expect(context.app.lastFrame()).toContain('Answer saved');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['abort', 'answer'] as const)('waits for human %s selection before sending the next queued conversation', async (selection) => {
    const target = { goalId: goalRecord().id, objective: 'Selection fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], goals: [], questions: [target] });
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    const abort = vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Goal aborted' });
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved' });
    const command = selection === 'abort' ? `/abort ${target.goalId}` : `/answer ${target.question.id}`;
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, command);
      await typeAndSubmit(context, 'continue after selection');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('Queued messages: 2');
        expect(queuedFrame(context)).toContain(command);
        expect(queuedFrame(context)).toContain('continue after selection');
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
      turn.resolve(response(null));
      await waitFor(() => {
        const frame = context.app.lastFrame()!.replace(/[│\s]+/gu, ' ');
        expect(frame).toContain(selection === 'abort' ? getLabel('manager.abortWarning', 'en') : 'Free text');
        expect(queuedFrame(context)).toContain('continue after selection');
        expect(queuedFrame(context)).toContain('Queued messages: 1');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(context.call).toHaveBeenCalledOnce();
      });
      expect(context.call).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
      expect(answer).not.toHaveBeenCalled();

      context.app.stdin.write(selection === 'abort' ? UP : '\x1b[B');
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        if (selection === 'abort') {
          expect(abort).toHaveBeenCalledExactlyOnceWith({ goalId: target.goalId, abortSignal: expect.any(AbortSignal) });
          expect(answer).not.toHaveBeenCalled();
        } else {
          expect(answer).toHaveBeenCalledExactlyOnceWith({ goalId: target.goalId, questionId: target.question.id, text: 'JSON', abortSignal: expect.any(AbortSignal) });
          expect(abort).not.toHaveBeenCalled();
        }
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'continue after selection']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
    } finally {
      context.app.unmount();
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it.each(['complete arrow', 'split arrow'] as const)('approves the displayed summary 400ms after an up arrow: %s', async (delivery) => {
    const context = mount();
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      vi.useFakeTimers();
      if (delivery === 'complete arrow') context.app.stdin.write(UP);
      else {
        context.app.stdin.write('\x1b');
        context.app.stdin.write('[A');
      }
      await vi.advanceTimersByTimeAsync(400);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA })));
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); vi.useRealTimers(); await context.session.close(); }
  });

  it.each([ENTER, '\x1b[27u'])('cancels abort confirmation with %j before sending the next queued conversation', async (key) => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    const abort = vi.spyOn(context.session, 'abortGoal');
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, `/abort ${goalRecord().id}`);
      await typeAndSubmit(context, 'conversation after cancellation');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('Queued messages: 2');
        expect(queuedFrame(context)).toContain(`/abort ${goalRecord().id}`);
        expect(queuedFrame(context)).toContain('conversation after cancellation');
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
        expect(queuedFrame(context)).toContain('conversation after cancellation');
        expect(queuedFrame(context)).toContain('Queued messages: 1');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(context.call).toHaveBeenCalledOnce();
      });
      expect(context.call).toHaveBeenCalledOnce();
      context.app.stdin.write(key);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'conversation after cancellation']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
      });
      expect(abort).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it.each([0, 800])('approves with an up arrow and Enter 400ms apart when the post-turn display refresh is slow, waiting %ims before the arrow', async (beforeArrow) => {
    const emptySnapshot = { events: [], diagnostics: [], questions: [], goals: [] };
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(emptySnapshot);
    const context = mount();
    try {
      await waitFor(() => expect(readEvents).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      context.call.mockImplementationOnce(async () => {
        readEvents.mockImplementationOnce(() => new Promise((resolve) => {
          setTimeout(() => resolve(emptySnapshot), 700);
        }));
        return response(summaryA);
      });
      await send(context, 'CSV出力を追加したい', summaryA);
      await vi.advanceTimersByTimeAsync(beforeArrow);
      context.app.stdin.write(UP);
      await vi.advanceTimersByTimeAsync(400);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA })));
      expect(context.call).toHaveBeenCalledOnce();
    } finally {
      context.app.unmount();
      await vi.advanceTimersByTimeAsync(700);
      vi.useRealTimers();
      await context.session.close();
    }
  });

  it('exits on Ctrl+C while goal registration is pending', async () => {
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      context.app.stdin.write('\x03');
      await waitFor(() => expect(context.onExit).toHaveBeenCalledOnce());
      registration.resolve(goalRecord());
      await context.session.close();
      expect(context.call).toHaveBeenCalledOnce();
    } finally {
      context.app.unmount();
      registration.resolve(goalRecord());
      await context.session.close();
    }
  });

  it('shows the draft and its cursor during startup recovery and keeps the draft after completion', async () => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const originalChalkLevel = chalk.level;
    chalk.level = 1;
    try {
      const context = mount('en', startup);
      try {
        await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
        context.app.stdin.write('recovery draft');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('recovery draft');
          expect(prompt).toContain('recovery draft\x1b[7m \x1b[27m');
        });
        context.app.stdin.write('\x1b[D');
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          const prompt = frame.slice(frame.lastIndexOf('╭'));
          expect(stripVTControlCharacters(frame)).toContain('Working');
          expect(stripVTControlCharacters(prompt)).toContain('recovery draft');
          expect(prompt).toContain('recovery draf\x1b[7mt\x1b[27m');
        });
        expect(context.call).not.toHaveBeenCalled();
        recovery.resolve(['recovery complete']);
        await waitFor(() => {
          const frame = context.app.lastFrame()!;
          expect(stripVTControlCharacters(frame)).toContain('recovery complete');
          expect(stripVTControlCharacters(frame)).not.toContain('Working');
          expect(stripVTControlCharacters(frame.slice(frame.lastIndexOf('╭')))).toContain('recovery draft');
        });
        context.app.stdin.write(ENTER);
        await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('recovery draft', expect.any(Object)));
      } finally {
        context.app.unmount();
        recovery.resolve([]);
        await context.session.close();
      }
    } finally {
      chalk.level = originalChalkLevel;
    }
  });

  it('queues consecutive submissions before a redraw and sends them after startup in FIFO order', async () => {
    const recovery = deferred<readonly string[]>();
    const turn = deferred<ReturnType<typeof response>>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      context.app.stdin.write('first startup request');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('second startup request');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('startup draft');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('first startup request');
        expect(queuedFrame(context)).toContain('second startup request');
        expect(queuedFrame(context)).toMatch(/Queued messages: 2/u);
        expect(promptFrame(context)).toContain('startup draft');
      });
      expect(context.call).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('first startup request', expect.any(Object)));
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first startup request', 'second startup request']);
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(promptFrame(context)).toContain('startup draft');
        expect(queuedFrame(context)).toBeUndefined();
      });
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      turn.resolve(response(null));
      await context.session.close();
    }
  });

  it('does not send queued startup input after recovery fails', async () => {
    const recovery = deferred<readonly string[]>();
    const failure = new Error('recovery failed');
    const startup = { run: vi.fn(async () => { await recovery.promise; throw failure; }), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'queued before startup failure');
      await waitFor(() => expect(queuedFrame(context)).toContain('queued before startup failure'));
      recovery.resolve([]);
      await waitFor(() => expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure));
      await waitFor(() => expect(queuedFrame(context)).toBeUndefined());
      context.app.stdin.write('after failure');
      context.app.stdin.write(ENTER);
      await context.session.close();
      expect(context.call).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input while stdout is flushing with Esc=%s', async (interrupt) => {
    const flush = deferred<void>();
    startupDoubles.flush.mockReturnValueOnce(flush.promise);
    const startup = { run: vi.fn(async (_signal: AbortSignal) => [] as string[]), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledOnce());
      for (const text of ['first startup request', 'second startup request']) {
        await typeAndSubmit(context, text);
        await waitFor(() => expect(queuedFrame(context)).toContain(text));
      }
      expect(queuedFrame(context)).toContain('Queued messages: 2');
      expect(startup.run).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => expect(queuedFrame(context)).toBeUndefined());
        expect(context.app.lastFrame()).toContain('Working');
      }
      expect(context.onExit).not.toHaveBeenCalled();
      flush.resolve();
      await waitFor(() => {
        expect(startup.run).toHaveBeenCalledTimes(interrupt ? 0 : 1);
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(interrupt
          ? [] : ['first startup request', 'second startup request']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.onExit).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      flush.resolve();
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input and late startup success with Esc=%s', async (interrupt) => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn((_signal: AbortSignal) => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      const signal = startup.run.mock.calls[0]![0];
      for (const text of ['first startup request', 'second startup request']) {
        await typeAndSubmit(context, text);
        await waitFor(() => expect(queuedFrame(context)).toContain(text));
      }
      expect(queuedFrame(context)).toContain('Queued messages: 2');
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => {
          expect(signal.aborted).toBe(true);
          expect(queuedFrame(context)).toBeUndefined();
        });
        expect(context.app.lastFrame()).toContain('Working');
      } else expect(signal.aborted).toBe(false);
      expect(context.onExit).not.toHaveBeenCalled();
      recovery.resolve(['late recovery diagnostic']);
      await waitFor(() => {
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(interrupt
          ? [] : ['first startup request', 'second startup request']);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      if (interrupt) expect(context.app.lastFrame()).not.toContain('late recovery diagnostic');
      else expect(context.app.lastFrame()).toContain('late recovery diagnostic');
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.onExit).not.toHaveBeenCalled();

      if (interrupt) {
        await typeAndSubmit(context, 'fresh request');
        await waitFor(() => {
          expect(context.call.mock.calls.map(([text]) => text)).toEqual(['fresh request']);
          expect(context.app.lastFrame()).not.toContain('Working');
          expect(queuedFrame(context)).toBeUndefined();
        });
      }
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it.each([false, true])('handles queued input and late startup rejection with Esc=%s', async (interrupt) => {
    const recovery = deferred<readonly string[]>();
    const failure = new Error('recovery failed');
    const startup = { run: vi.fn((_signal: AbortSignal) => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      const signal = startup.run.mock.calls[0]![0];
      await typeAndSubmit(context, 'queued before startup failure');
      await waitFor(() => expect(queuedFrame(context)).toContain('queued before startup failure'));
      expect(context.call).not.toHaveBeenCalled();

      if (interrupt) {
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => {
          expect(signal.aborted).toBe(true);
          expect(queuedFrame(context)).toBeUndefined();
        });
        expect(context.app.lastFrame()).toContain('Working');
      } else expect(signal.aborted).toBe(false);
      expect(context.onExit).not.toHaveBeenCalled();
      recovery.reject(failure);
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));

      if (interrupt) expect(startup.fail).not.toHaveBeenCalled();
      else expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure);
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();
      expect(context.onExit).not.toHaveBeenCalled();
    } finally {
      context.app.unmount();
      recovery.resolve([]);
      await context.session.close();
    }
  });

  it('keeps a draft and waits for registration before sending queued conversation', async () => {
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'conversation after registration');
      context.app.stdin.write('registration draft');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('conversation after registration');
        expect(promptFrame(context)).toContain('registration draft');
      });
      expect(context.call).toHaveBeenCalledOnce();
      registration.resolve(goalRecord());
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls[1]![0]).toBe('conversation after registration');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(promptFrame(context)).toContain('registration draft');
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(context.register).toHaveBeenCalledOnce();
    } finally {
      context.app.unmount();
      registration.resolve(goalRecord());
      await context.session.close();
    }
  });

  it('discards queued conversation with Esc while goal registration is pending', async () => {
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'discard during registration');
      await waitFor(() => expect(queuedFrame(context)).toContain('discard during registration'));

      context.app.stdin.write('\x1b[27u');
      await waitFor(() => expect(queuedFrame(context)).toBeUndefined());
      registration.resolve(goalRecord());
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.register).toHaveBeenCalledOnce();
    } finally {
      context.app.unmount();
      registration.resolve(goalRecord());
      await context.session.close();
    }
  });

  it.each(['assignment', 'questions', 'goals'] as const)('skips unchanged polling renders and updates changed %s in the same screen', async (field) => {
    let assignment = { kind: 'workspace' as const, workspaceId: '650e8400-e29b-41d4-a716-446655440002', name: 'Original workspace', repositoryDirectories: [cwd] };
    let snapshot = { events: [], diagnostics: [], questions: [{ goalId: goalRecord().id, objective: 'Question fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Original question',
    } }], goals: [{ id: goalRecord().id, objective: 'Original paused goal', executionStatus: 'paused' as const }] };
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockImplementation(async () => structuredClone(snapshot));
    const context = mount();
    vi.spyOn(context.session, 'getAssignment').mockImplementation(async () => structuredClone(assignment));
    try {
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Original workspace');
        expect(context.app.lastFrame()).toContain('Original question');
        expect(context.app.lastFrame()).toContain('Original paused goal');
      });
      const beforePolls = readEvents.mock.calls.length;
      const beforeCommits = context.commits.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(beforePolls + 2);
        expect(context.app.lastFrame()).toContain('Original workspace');
        expect(context.app.lastFrame()).toContain('Original question');
        expect(context.app.lastFrame()).toContain('Original paused goal');
      });
      expect.soft(context.commits).toHaveBeenCalledTimes(beforeCommits);

      if (field === 'assignment') assignment = { ...assignment, name: 'Changed workspace' };
      else if (field === 'questions') snapshot = { ...snapshot, questions: [{ ...snapshot.questions[0]!, question: { ...snapshot.questions[0]!.question, body: 'Changed question' } }] };
      else snapshot = { ...snapshot, goals: [{ ...snapshot.goals[0]!, objective: 'Changed paused goal' }] };
      const changed = field === 'assignment' ? 'Changed workspace' : field === 'questions' ? 'Changed question' : 'Changed paused goal';
      const original = field === 'assignment' ? 'Original workspace' : field === 'questions' ? 'Original question' : 'Original paused goal';
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain(changed);
        expect(context.app.lastFrame()).not.toContain(original);
      });
      const afterChange = context.commits.mock.calls.length;
      const afterPolls = readEvents.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(afterPolls + 2);
        expect(context.app.lastFrame()).toContain(changed);
        expect(context.app.lastFrame()).not.toContain(original);
      });
      expect.soft(context.commits).toHaveBeenCalledTimes(afterChange);
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('shows consecutive refresh errors once and reports changes or failures after recovery', async () => {
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockRejectedValue(new Error('refresh error A'));
    const context = mount();
    try {
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(context.app.lastFrame()?.match(/refresh error A/gu)).toHaveLength(1);
      });

      readEvents.mockRejectedValue(new Error('refresh error B'));
      const beforeChange = readEvents.mock.calls.length;
      await waitFor(() => {
        expect(readEvents.mock.calls.length).toBeGreaterThanOrEqual(beforeChange + 2);
        expect(context.app.lastFrame()?.match(/refresh error B/gu)).toHaveLength(1);
      });

      readEvents.mockResolvedValue({ events: [], diagnostics: [], questions: [], goals: [] });
      const beforeRecovery = readEvents.mock.calls.length;
      await waitFor(() => expect(readEvents.mock.calls.length).toBeGreaterThan(beforeRecovery));
      readEvents.mockRejectedValue(new Error('refresh error A'));
      await waitFor(() => expect(context.app.lastFrame()?.match(/refresh error A/gu)).toHaveLength(2));
      expect(context.call).not.toHaveBeenCalled();
      expect(failureNotice).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps displaying and reading workspace B after A is removed in the turn that adds B', async () => {
    const repositoryB = '/test/repository-b';
    const repository = { kind: 'repository' as const, repositoryDirectory: cwd, repositoryDirectories: [cwd] };
    const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
    let savedWorkspace: workspaceRegistry.Workspace | undefined;
    vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockImplementation(async (_globalConfigDirectory, directory) =>
      savedWorkspace?.repositoryDirectories.includes(directory) ? savedWorkspace : undefined);
    vi.spyOn(workspaceRegistry, 'readWorkspace').mockImplementation(async (_globalConfigDirectory, id) =>
      savedWorkspace?.id === id ? savedWorkspace : undefined);
    const readEvents = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], questions: [], goals: [] });
    const context = mount('en', undefined, repository);
    try {
      await waitFor(() => expect(readEvents).toHaveBeenCalledWith(cwd, 'en'));
      context.call.mockImplementationOnce(async (_prompt, options) => {
        options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: repositoryB } } });
        savedWorkspace = workspace;
        options.onStream?.({ type: 'tool_result', data: { id: 'add-b', isError: false, content: JSON.stringify({ workspace }) } });
        savedWorkspace = { ...workspace, repositoryDirectories: [repositoryB] };
        readEvents.mockClear();
        return response(null);
      });
      context.app.stdin.write('add B and remove A');
      await waitFor(() => expect(promptFrame(context)).toContain('add B and remove A'));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain('A + B (1)'));
      expect(readEvents).toHaveBeenCalledWith(repositoryB, 'en');
      expect(readEvents.mock.calls.every(([directory, language]) => directory === repositoryB && language === 'en')).toBe(true);
      expect(await context.session.getAssignment()).toMatchObject({ kind: 'workspace', workspaceId: workspace.id, repositoryDirectories: [repositoryB] });
    } finally { context.app.unmount(); await context.session.close(); }
  });

  describe.each([
    { lang: 'ja' as const, changes: /manager は実験的機能.*動作・設定・保存するデータの形式.*予告なく/u, costs: /自動でタスクを投入・実行.*provider の API の費用/u },
    { lang: 'en' as const, changes: /manager is experimental.*behavior, settings, and saved data formats.*without notice/iu, costs: /automatically queues and runs tasks.*provider API costs/iu },
  ])('experimental notices in $lang', ({ lang, changes, costs }) => {
    function expectNotices(frame: string | undefined): void {
      const text = frame?.replace(/\s+/gu, ' ');
      expect(text).toMatch(changes);
      expect(text).toMatch(costs);
      expect(text).toContain('Enter: send');
      expect(text!.search(costs)).toBeLessThan(text!.indexOf('Enter: send'));
    }

    it('shows both notices on every startup without calling the provider', async () => {
      for (let startup = 0; startup < 2; startup++) {
        const context = mount(lang);
        await waitFor(() => expectNotices(context.app.lastFrame()));
        expect(context.call).not.toHaveBeenCalled();
        expect(context.register).not.toHaveBeenCalled();
        context.app.unmount();
        await context.session.close();
      }
    });

    it('displays both notices and waits for stdout before running startup recovery and automatic execution', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = {
        run: vi.fn(async () => {
          expectNotices(context.app.lastFrame());
          return ['startup diagnostic'];
        }),
        fail: vi.fn(),
      };
      const context = mount(lang, startup);
      try {
        await waitFor(() => {
          expectNotices(context.app.lastFrame());
          expect(startupDoubles.flush).toHaveBeenCalledTimes(1);
        });
        expect(startup.run).not.toHaveBeenCalled();
        context.app.stdin.write('startup draft');
        await waitFor(() => expect(promptFrame(context)).toContain('startup draft'));
        expect(context.call).not.toHaveBeenCalled();

        finishFlush();
        await waitFor(() => {
          expect(context.app.lastFrame()).toContain('startup diagnostic');
          expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
          expect(promptFrame(context)).toContain('startup draft');
        });
        expect(startup.run).toHaveBeenCalledTimes(1);
        expect(startup.fail).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        expect(promptFrame(context)).toContain('startup draft');
        context.app.stdin.write(ENTER);
        await waitFor(() => expect(context.session.getPendingSummary()?.summary).toEqual(summaryA));
        expect(context.call).toHaveBeenCalledExactlyOnceWith('startup draft', expect.any(Object));
        expectNotices(context.app.lastFrame());
        expect(startup.run).toHaveBeenCalledTimes(1);
      } finally {
        context.app.unmount();
        finishFlush();
        await context.session.close();
      }
    });

    it.each(['flush', 'startup'] as const)('reports a %s failure to the mount', async (source) => {
      const failure = new Error(`${source} failed`);
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      if (source === 'flush') startupDoubles.flush.mockRejectedValueOnce(failure);
      else startup.run.mockRejectedValueOnce(failure);
      const context = mount(lang, startup);

      await waitFor(() => expect(startup.fail).toHaveBeenCalledExactlyOnceWith(failure));
      expect(startup.run).toHaveBeenCalledTimes(source === 'flush' ? 0 : 1);
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('accepts Ctrl+C while stdout is flushing and skips recovery', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async (_signal: AbortSignal) => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x03');
      await waitFor(() => expect(context.onExit).toHaveBeenCalledTimes(1));
      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;

      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it.each([false, true])('aborts recovery on Ctrl+C without submitting further input when recovery rejects=%s', async (rejects) => {
      let finishRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
      const startup = {
        run: vi.fn(async (signal: AbortSignal) => {
          await recovery;
          if (rejects) throw signal.reason;
          return ['late recovery diagnostic'];
        }),
        fail: vi.fn(),
      };
      const context = mount(lang, startup);
      await waitFor(() => expect(startup.run).toHaveBeenCalledTimes(1));
      const signal = startup.run.mock.calls[0]![0];

      context.app.stdin.write('ignored');
      context.app.stdin.write(ENTER);
      const beforeExit = promptFrame(context);
      context.app.stdin.write('\x03');
      await waitFor(() => {
        expect(signal.aborted).toBe(true);
        expect(context.onExit).toHaveBeenCalledTimes(1);
      });
      finishRecovery();
      await Promise.allSettled([startup.run.mock.results[0]!.value]);
      context.app.stdin.write('ignored after abort');
      context.app.stdin.write(ENTER);
      context.app.stdin.write('\x03');

      expect(context.onExit).toHaveBeenCalledTimes(1);
      expect(startup.fail).not.toHaveBeenCalled();
      expect(context.app.lastFrame()).not.toContain('late recovery diagnostic');
      expect(promptFrame(context)).toBe(beforeExit);
      expect(context.call).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('does not start recovery when the TUI unmounts before stdout is flushed', async () => {
      let finishFlush!: () => void;
      startupDoubles.flush.mockReturnValueOnce(new Promise<void>((resolve) => { finishFlush = resolve; }));
      const startup = { run: vi.fn(async () => [] as string[]), fail: vi.fn() };
      const context = mount(lang, startup);
      await waitFor(() => expect(startupDoubles.flush).toHaveBeenCalledTimes(1));
      context.app.unmount();

      finishFlush();
      await startupDoubles.flush.mock.results[0]!.value;
      expect(startup.run).not.toHaveBeenCalled();
      expect(startup.fail).not.toHaveBeenCalled();
      await context.session.close();
    });

    it('keeps both notices above the input after a conversation redraw and a summary', async () => {
      const context = mount(lang);
      await waitFor(() => expectNotices(context.app.lastFrame()));
      await send(context, 'CSV出力を追加したい', summaryA);
      expectNotices(context.app.lastFrame());
    });

    it.each([40, 80])('wraps both notices within a %i-column terminal', async (columns) => {
      const context = mount(lang);
      vi.spyOn(context.app.stdout, 'columns', 'get').mockReturnValue(columns);
      context.app.rerender(createElement(ManagerView, {
        cwd, lang, session: context.session, initialDiagnostics: [], onExit: vi.fn(),
      }));

      await waitFor(() => {
        const frame = context.app.lastFrame()!;
        const text = frame.replace(/\s+/gu, '');
        for (const key of ['manager.experimentalNotice', 'manager.costNotice']) {
          expect(text).toContain(getLabel(key, lang).replace(/\s+/gu, ''));
        }
        for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      });
      expect(context.call).not.toHaveBeenCalled();
    });
  });

  it('does not register quoted summaries when the provider has no current summary', async () => {
    const context = mount();
    const { app, call, register, session } = context;
    const structuredOutput = { message: `Quoted summary: ${JSON.stringify(summaryA)}`, summary: null };
    call.mockResolvedValueOnce({ ...response(summaryA), content: JSON.stringify(structuredOutput), structuredOutput });
    await waitFor(() => expect(app.lastFrame()).toContain(cwd));
    app.stdin.write('要件を相談したい');
    await waitFor(() => expect(promptFrame(context)).toContain('要件を相談したい'));
    app.stdin.write(ENTER);
    await waitFor(() => {
      expect(app.lastFrame()).toContain('Quoted summary');
      expect(app.lastFrame()).not.toContain('Working');
      expect(queuedFrame(context)).toBeUndefined();
      expect(promptFrame(context)).toContain('Discuss your goal');
    });
    app.stdin.write(UP);
    app.stdin.write(ENTER);
    expect(session.getPendingSummary()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
  it('identifies the manager, target repository and experimental status without starting a conversation', async () => {
    const { app, call, register } = mount();

    await waitFor(() => {
      expect(app.lastFrame()).toMatch(/manager/iu);
      expect(app.lastFrame()).toContain(cwd);
      expect(app.lastFrame()).toMatch(/experimental/iu);
    });
    expect(call).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('continues conversation on the default confirmation choice without registering', async () => {
    const context = mount();
    const { app, register } = context;
    await waitFor(() => expect(app.lastFrame()).toContain(cwd));
    await send(context, 'CSV出力を追加したい', summaryA);

    app.stdin.write(ENTER);
    await waitFor(() => expect(context.session.getPendingSummary()).toBeNull());
    await send(context, '範囲外の内容を確認してください', summaryA);

    expect(register).not.toHaveBeenCalled();
  });

  it('approves the revised displayed summary only through the confirmation keys in the same mounted screen', async () => {
    const context = mount();
    const { app, call } = context;
    await waitFor(() => expect(app.lastFrame()).toContain(cwd));
    await send(context, 'CSV出力を追加したい', summaryA);
    app.stdin.write(ENTER);
    call.mockResolvedValueOnce(response(summaryB));
    await send(context, 'JSONに変更してください', summaryB);
    await approve(context, summaryB);
  });

  describe.each(['ja', 'en'] as const)('approval lists in %s', (lang) => {
    describe.each(['structuredOutput', 'content'] as const)('array boundaries from %s', (format) => {
      describe.each(['outOfScope', 'acceptanceCriteria', 'constraints'] as const)('%s', (field) => {
        it.each([
          ['CSV', '通知'],
          ['CSV; 通知'],
          ['CSV","通知'],
          ['CSV\n通知\t\\'],
          ['CSV'],
          ['CSV', 'CSV'],
        ])('shows separate bullets for %j and registers the original array', async (...values) => {
          const context = mount(lang);
          const summary = { objective: summaryA.objective, outOfScope: ['基準'], acceptanceCriteria: ['基準'], constraints: [], [field]: values, };
          const reply = response(summary);
          context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
          await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

          await send(context, '要約を確認してください', summary);

          const lines = context.app.lastFrame()!.split('\n').map((line) => line.replace(/^[│\s]+|[│\s]+$/gu, ''));
          const label = field === 'outOfScope'
            ? (lang === 'ja' ? '範囲外:' : 'Out of scope:')
            : field === 'acceptanceCriteria'
              ? (lang === 'ja' ? '受け入れ条件:' : 'Acceptance criteria:')
              : (lang === 'ja' ? '作業の制約:' : 'Work constraints:');
          const index = lines.indexOf(label);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(lines.slice(index + 1).filter((line) => line.startsWith('- ')).slice(0, values.length))
            .toEqual(values.map((value) => `- ${toDisplayText(value).split('\n')[0]}`));
          await approve(context, summary);
        });

        it('indents continuation lines by the bullet width and registers the original array', async () => {
          const context = mount(lang);
          const values = ['CSV\n通知\n配信', '次の項目'];
          const summary = { ...summaryA, [field]: values };
          const reply = response(summary);
          context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
          await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

          await send(context, '要約を確認してください', summary);

          const lines = context.app.lastFrame()!.split('\n')
            .map((line) => line.replace(/^│/u, '').replace(/[│\s]+$/gu, ''));
          const index = lines.indexOf('- CSV');
          expect(index).toBeGreaterThanOrEqual(0);
          expect(lines.slice(index, index + 4)).toEqual(['- CSV', '  通知', '  配信', '- 次の項目']);
          await approve(context, summary);
        });
      });

      it('shows an empty out-of-scope list without changing the registered summary', async () => {
        const context = mount(lang);
        const summary = { ...summaryA, outOfScope: [] };
        const reply = response(summary);
        context.call.mockResolvedValueOnce({ ...reply, structuredOutput: format === 'content' ? undefined : reply.structuredOutput });
        await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));

        await send(context, '要約を確認してください', summary);

        expect(context.app.lastFrame()).not.toContain('[]');
        await approve(context, summary);
      });
    });

    it('sanitizes each displayed bullet independently', async () => {
      const context = mount(lang);
      const summary = { ...summaryA, outOfScope: ['CSV\x1b[', '通知'], acceptanceCriteria: ['\x1b[31mCSVを取得できる\x1b[0m'] };
      vi.spyOn(context.session, 'getPendingSummary').mockReturnValue({ revision: 1, summary });
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write('要約を確認してください');
      await waitFor(() => expect(promptFrame(context)).toContain('要約を確認してください'));
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('- CSV');
        expect(context.app.lastFrame()).toContain('- 通知');
        expect(context.app.lastFrame()).toContain('- CSVを取得できる');
        expect(context.app.lastFrame()).not.toContain('\x1b');
      });
    });
  });
});

it('displays run manager work records without processing inbox events and informs the next human turn', async () => {
  const context = mount('ja');
  context.call.mockResolvedValue(response(null));
  try {
    inbox.read.mockReturnValue([{ filePath: '/inbox/1.json', event: { kind: 'registered', goalId: goalRecord().id, createdAt: '2026-10-14T00:00:00Z' } }]);
    const record = { id: '550e8400-e29b-41d4-a716-446655440005', recordedAt: '2026-10-14T00:00:00Z', summary: 'task-X を取り込み、task-Y を投入しました' };
    memory.goals.mockReturnValue([{ ...goalRecord(), workLog: [record] }]);
    await waitFor(() => expect(context.app.lastFrame()).toContain(record.summary));
    expect(context.call).not.toHaveBeenCalled();
    expect(inbox.read).not.toHaveBeenCalled();
    expect(inbox.remove).not.toHaveBeenCalled();
    context.app.stdin.write('進捗を教えてください');
    await waitFor(() => expect(promptFrame(context)).toContain('進捗を教えてください'));
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
    expect(context.call.mock.calls[0]![0]).toContain(record.summary);
  } finally { context.app.unmount(); await context.session.close(); }
});


it('notifies each failed TUI conversation and displays its blocked message', async () => {
  failureNotice.mockResolvedValue('Blocked conversation notice');
  const context = mount();
  context.call.mockRejectedValue(new Error('provider failed'));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await typeAndSubmit(context, '進めてください');
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(attempt + 1);
        expect(failureNotice).toHaveBeenCalledTimes(attempt + 1);
        expect(context.app.lastFrame()?.match(/Blocked conversation notice/gu)).toHaveLength(attempt + 1);
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
      expect(failureNotice).toHaveBeenLastCalledWith(cwd, undefined, expect.objectContaining({ message: 'provider failed' }));
      expect(context.app.lastFrame()).toContain('Blocked conversation notice');
    }
    expect(context.session.getPendingSummary()).toBeNull();
    expect(context.register).not.toHaveBeenCalled();
  } finally { context.app.unmount(); await context.session.close(); }
});
