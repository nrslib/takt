import { openMenu, chooseGoalAction, selectionFrame, enterSelection, memory, cwd, summaryA, ENTER, UP, LONG_TEXT, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit, send } from './manager-tui-fixtures.js';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import * as savedEvents from '../../features/manager/savedEvents.js';
import { getLabel } from '../../shared/i18n/index.js';
import { goalRecord } from './goal-fixtures.js';

describe('manager TUI input', () => {
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

  it.each(['separate CR', 'last character with CR', 'last character with LF', 'last character with CRLF'] as const)('sends character-by-character input with one immediate Enter and clears the prompt: %s', async (delivery) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    const text = `${'長い文章を1文字ずつ入力します。'.repeat(80)}最終文字`;
    try {
      await waitFor(() => expect(promptFrame(context)).toContain('Discuss your goal'));
      for (const character of text.slice(0, -1)) context.app.stdin.write(character);
      await waitFor(() => expect(promptFrame(context)).toContain('最終文'));
      expect(context.call).not.toHaveBeenCalled();
      const lastCharacter = text.slice(-1);
      if (delivery === 'separate CR') {
        context.app.stdin.write(lastCharacter);
        context.app.stdin.write(ENTER);
      } else context.app.stdin.write(`${lastCharacter}${delivery === 'last character with LF' ? '\n' : delivery === 'last character with CRLF' ? '\r\n' : ENTER}`);

      await waitFor(() => {
        expect(context.call, JSON.stringify({ prompt: promptFrame(context).slice(-400), sent: context.call.mock.calls.map(([body]) => body) })).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object));
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('最終文字');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['separate chunks', 'one bracketed paste chunk', 'one unbracketed chunk'] as const)('sends a long paste with one immediate Enter and clears the input: %s', async (delivery) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    const text = LONG_TEXT;
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));
      if (delivery === 'separate chunks') {
        context.app.stdin.write(text);
        context.app.stdin.write(ENTER);
      } else if (delivery === 'one bracketed paste chunk') context.app.stdin.write(`\x1b[200~${text}\x1b[201~${ENTER}`);
      else context.app.stdin.write(`${text}${ENTER}`);

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

  it.each(['separate chunks', 'one unbracketed chunk', 'one bracketed paste chunk', 'bracketed body CR before separate Enter'] as const)('sends a long free-text answer once without sending it as conversation: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Where should the output go?',
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    const text = `${'詳細な回答を保存してください。'.repeat(80)}回答の末尾`;
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Enter your answer');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      if (delivery === 'separate chunks') {
        context.app.stdin.write(text);
        context.app.stdin.write(ENTER);
      } else if (delivery === 'one unbracketed chunk') context.app.stdin.write(`${text}${ENTER}`);
      else if (delivery === 'one bracketed paste chunk') context.app.stdin.write(`\x1b[200~${text}\x1b[201~${ENTER}`);
      else {
        context.app.stdin.write(`\x1b[200~${text}\r\x1b[201~`);
        await waitFor(() => expect(promptFrame(context)).toContain('回答の末尾'));
        expect(answer).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        expect(queuedFrame(context)).toBeUndefined();
        context.app.stdin.write(ENTER);
      }
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('回答の末尾');
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, repositoryDirectory: cwd, questionId: target.question.id, answer: { text }, abortSignal: expect.any(AbortSignal),
        });
        expect(promptFrame(context)).toContain('Discuss your goal');
        expect(promptFrame(context)).not.toContain('回答の末尾');
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['plain text without Enter', 'unbracketed body containing internal CR', 'unbracketed body containing internal LF', 'bracketed paste containing CR'] as const)('keeps a long draft unsent until an outside Enter: %s', async (delivery) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    const text = delivery === 'unbracketed body containing internal CR' ? `${LONG_TEXT}続き`
      : delivery === 'unbracketed body containing internal LF' ? `${LONG_TEXT}\n続き` : LONG_TEXT;
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));
      context.app.stdin.write(delivery === 'plain text without Enter' ? LONG_TEXT
        : delivery === 'unbracketed body containing internal CR' ? `${LONG_TEXT}\r続き`
          : delivery === 'unbracketed body containing internal LF' ? text : `\x1b[200~${LONG_TEXT}\r\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();

      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object));
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
      await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));
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

  it('sends pasted slash text as conversation only after a separate Enter', async () => {
    const context = mount();
    memory.goals.mockReturnValue([goalRecord()]);
    context.call.mockResolvedValue(response(null));
    const pause = vi.spyOn(context.session, 'pauseGoal');
    const message = vi.spyOn(context.session, 'handleUserMessage');
    const text = '/pause';
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(`\x1b[200~${text}\r\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain(text));
      expect(pause).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      expect(queuedFrame(context)).toBeUndefined();
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(message).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(pause).not.toHaveBeenCalled();
      expect(selectionFrame(context)).toBeUndefined();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  describe.each(['turn', 'startup', 'registration'] as const)('long input during %s', (state) => {
    it.each([
      { delivery: 'bracketed draft', submitBeforeCompletion: false },
      { delivery: 'bracketed draft', submitBeforeCompletion: true },
      { delivery: 'unbracketed submission', submitBeforeCompletion: true },
    ])('preserves submission timing for $delivery before completion=$submitBeforeCompletion', async ({ delivery, submitBeforeCompletion }) => {
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

        context.app.stdin.write(delivery === 'bracketed draft' ? `\x1b[200~${LONG_TEXT}\r\x1b[201~` : `${LONG_TEXT}\r`);
        if (delivery === 'bracketed draft') {
          await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
          expect(context.call.mock.calls.map(([text]) => text)).toEqual(before);
          expect(queuedFrame(context)).toBeUndefined();
        }

        if (submitBeforeCompletion) {
          if (delivery === 'bracketed draft') context.app.stdin.write(ENTER);
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
      if (delivery === 'one unbracketed chunk') context.app.stdin.write(`${LONG_TEXT}${ENTER}`);
      else context.app.stdin.write(`\x1b[200~${LONG_TEXT}\r\x1b[201~${ENTER}`);

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
    memory.goals.mockReturnValue([goalRecord()]);
    const context = mount();
    const abort = vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Goal aborted' });
    try {
      await openMenu(context, 'goal');
      await enterSelection(context);
      await chooseGoalAction(context, 'abort');
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

  it('keeps vertical cursor movement in a free-text question answer', async () => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Where should the output go?',
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      context.app.stdin.write('\x1b[200~first\nsecond\x1b[201~');
      await waitFor(() => expect(promptFrame(context)).toContain('second'));
      context.app.stdin.write(UP);
      context.app.stdin.write('!');
      await waitFor(() => expect(promptFrame(context)).toContain('first!'));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith({
        goalId: target.goalId, repositoryDirectory: cwd, questionId: target.question.id,
        answer: { text: 'first!\nsecond' }, abortSignal: expect.any(AbortSignal),
      }));
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['selected option', 'plain text without Enter', 'one unbracketed chunk', 'bracketed paste containing CR'] as const)('routes selected options and pasted free text to the question: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Free text');
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      if (delivery === 'selected option') context.app.stdin.write(ENTER);
      else if (delivery === 'one unbracketed chunk') context.app.stdin.write(`${LONG_TEXT}\r`);
      else {
        context.app.stdin.write(delivery === 'plain text without Enter' ? LONG_TEXT
          : `\x1b[200~${LONG_TEXT}\r\x1b[201~`);
        await waitFor(() => expect(promptFrame(context)).toContain('末尾の確認'));
        expect(answer).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
        context.app.stdin.write(ENTER);
      }

      await waitFor(() => {
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, repositoryDirectory: cwd, questionId: target.question.id,
          answer: { text: delivery === 'selected option' ? 'CSV' : LONG_TEXT },
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
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Selection fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    const abort = vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Goal aborted' });
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'continue after selection');
      await waitFor(() => {
        expect(queuedFrame(context)).toContain('Queued messages: 1');
        expect(queuedFrame(context)).toContain('continue after selection');
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
      await openMenu(context, selection === 'abort' ? 'goal' : 'answer');
      await enterSelection(context);
      if (selection === 'abort') await chooseGoalAction(context, 'abort');
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
          expect(answer).toHaveBeenCalledExactlyOnceWith({ goalId: target.goalId, repositoryDirectory: cwd, questionId: target.question.id, answer: { text: 'JSON' }, abortSignal: expect.any(AbortSignal) });
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

});
