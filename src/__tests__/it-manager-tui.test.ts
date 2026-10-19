import { enterSelection, memory, failureNotice, cwd, summaryA, summaryB, ENTER, UP, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit, send, approve } from './helpers/manager-tui-fixtures.js';
import './helpers/manager-tui-input.js';
import './helpers/manager-tui-startup.js';
import './helpers/manager-tui-selection.js';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import { classifyManagerGoInput } from '../features/manager/useManagerInput.js';
import * as savedEvents from '../features/manager/savedEvents.js';
import { toDisplayText } from '../features/tui/displayText.js';
import { createGoal } from '../infra/goals/service.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

describe('manager TUI /go', () => {
  it.each([
    ['/go', 'command'], [' \t/go\t ', 'command'],
    ['/go extra', 'arguments'], ['/go\textra', 'arguments'],
    ['', 'draft'], [' ', 'draft'], ['/', 'draft'], ['/g', 'draft'],
    ['/go ', 'command'], ['/goal', null], ['`/go`', null], ['> /go', null],
    ['text /go', null], ['/go\n', null], ['/go\r', null], ['```\n/go\n```', null],
  ] as const)('classifies manager command input %j as %j', (text, expected) => {
    expect(classifyManagerGoInput(text)).toBe(expected);
  });

  it.each(['ja', 'en'] as const)('requests a summary in the existing %s conversation and waits for approval', async (lang) => {
    const context = mount(lang);
    context.call.mockResolvedValueOnce({ ...response(null), sessionId: 'manager-conversation' })
      .mockResolvedValueOnce(response(summaryB));
    try {
      await typeAndSubmit(context, 'JSON出力について相談したい');
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledOnce();
        expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      await typeAndSubmit(context, '/go');
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.app.lastFrame()).toContain(lang === 'ja' ? '登録する要約' : 'Summary to register');
        expect(context.app.lastFrame()).toContain(summaryB.objective);
      });
      const [request, options] = context.call.mock.calls[1]!;
      expect(request).not.toBe('/go');
      expect(request).toMatch(lang === 'ja' ? /要約/u : /summar/iu);
      expect(options.sessionId).toBe('manager-conversation');
      expect(context.app.lastFrame()).toContain('JSON出力について相談したい');
      expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['/go', '  /go  ', '\t/go\t'])('accepts a standalone command with surrounding whitespace: %j', async (command) => {
    const context = mount();
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write(`\x1b[200~${command}\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain('/go'));
      expect(context.call).not.toHaveBeenCalled();
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain('Summary to register'));
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.call.mock.calls[0]![0]).toMatch(/summar/iu);
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([
    '/goal', '`/go`', '> /go', '説明 /go',
    '```\n/go\n```', '~~~\n/go\n~~~', '> > /go',
    '```\n/go', '~~~\n/go', '/go\n続き',
  ])('sends non-command text unchanged as conversation: %j', async (text) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(context.app.lastFrame()).toContain(cwd));
      context.app.stdin.write(`\x1b[200~${text}\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain(text.split('\n')[0]!));
      expect(context.call).not.toHaveBeenCalled();
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object));
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  describe.each([false, true])('extra arguments with pending summary=%s', (pending) => {
    it.each(['/go extra', '/go\textra'])('shows usage without sending or registering: %j', async (text) => {
      const context = mount();
      try {
        if (pending) await send(context, 'CSV出力を追加したい', summaryA);
        const before = context.call.mock.calls.length;
        const summary = context.session.getPendingSummary();
        context.app.stdin.write(`\x1b[200~${text}\x1b[201~`);
        await waitFor(() => expect(promptFrame(context).replace(/\s+/gu, ' ')).toContain('/go extra'));
        context.app.stdin.write(ENTER);
        await waitFor(() => {
          const lines = context.app.lastFrame()!.split('\n').filter((line) => /usage|takes no arguments|no arguments|使い方|引数/iu.test(line));
          expect(lines.join('\n')).toContain('/go');
          expect(context.app.lastFrame()).not.toContain('Working');
          expect(queuedFrame(context)).toBeUndefined();
        });
        expect(context.call).toHaveBeenCalledTimes(before);
        expect(context.register).not.toHaveBeenCalled();
        expect(context.session.getPendingSummary()).toEqual(summary);
        if (pending) await approve(context, summaryA);
      } finally { context.app.unmount(); await context.session.close(); }
    });
  });

  it.each(['characters', 'plain chunk', 'bracketed paste', 'body with CR', 'body with LF'] as const)('approves the displayed summary once without regenerating it: %s', async (delivery) => {
    const context = mount();
    const approval = vi.spyOn(context.session, 'approveSummary');
    try {
      context.call.mockResolvedValueOnce(response(summaryB));
      await send(context, 'JSONを出力したい', summaryB);
      const revision = context.session.getPendingSummary()!.revision;
      if (delivery === 'characters') {
        for (const text of ['/', 'g', 'o']) {
          context.app.stdin.write(text);
          await waitFor(() => expect(context.app.lastFrame()).toContain('Summary to register'));
          expect(context.session.getPendingSummary()?.revision).toBe(revision);
        }
      } else if (delivery === 'bracketed paste') context.app.stdin.write('\x1b[200~/go\x1b[201~');
      else if (delivery === 'plain chunk') context.app.stdin.write('/go');
      if (delivery === 'body with CR' || delivery === 'body with LF') {
        context.app.stdin.write(`/go${delivery === 'body with CR' ? ENTER : '\n'}`);
      } else {
        await waitFor(() => expect(promptFrame(context)).toContain('/go'));
        expect(context.register).not.toHaveBeenCalled();
        expect(context.call).toHaveBeenCalledOnce();
        context.app.stdin.write(ENTER);
      }
      await waitFor(() => {
        expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
        expect(context.app.lastFrame()).toContain('Goal registered');
        expect(context.app.lastFrame()).toContain(goalRecord().branch);
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(approval).toHaveBeenCalledExactlyOnceWith(revision);
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.session.getPendingSummary()).toBeNull();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps the summary and a visible cursor while editing the command', async () => {
    const originalChalkLevel = chalk.level;
    chalk.level = 1;
    const context = mount();
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      const pending = context.session.getPendingSummary();
      context.app.stdin.write('/go');
      await waitFor(() => expect(promptFrame(context)).toContain('/go\x1b[7m \x1b[27m'));
      context.app.stdin.write('\x1b[D');
      await waitFor(() => expect(promptFrame(context)).toContain('/g\x1b[7mo\x1b[27m'));
      context.app.stdin.write('\x1b[C');
      context.app.stdin.write('\x7f');
      await waitFor(() => expect(stripVTControlCharacters(promptFrame(context))).toContain('/g'));
      expect(context.session.getPendingSummary()).toEqual(pending);
      context.app.stdin.write('o');
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA })));
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); chalk.level = originalChalkLevel; }
  });

  it.each(['ordinary text', 'newline'] as const)('dismisses the summary when the command draft becomes %s', async (change) => {
    const context = mount();
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write('/g');
      await waitFor(() => expect(promptFrame(context)).toContain('/g'));
      expect(context.session.getPendingSummary()).not.toBeNull();
      context.app.stdin.write(change === 'ordinary text' ? 'oal' : '\x1b[13;2u');
      await waitFor(() => {
        expect(context.session.getPendingSummary()).toBeNull();
        expect(context.app.lastFrame()).not.toContain('Summary to register');
      });
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['\x1b[13;2u', '\x1b[13;3u'])('inserts a newline instead of approving a summary from an empty draft: %j', async (key) => {
    const context = mount();
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.app.stdin.write(key);
      await waitFor(() => {
        expect(context.session.getPendingSummary()).toBeNull();
        expect(context.app.lastFrame()).not.toContain('Summary to register');
      });
      expect(context.register).not.toHaveBeenCalled();
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([false, true])('processes queued /go using the summary present after the active turn: %s', async (hasSummary) => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(summaryB));
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, '/go');
      await waitFor(() => expect(queuedFrame(context)).toContain('/go'));
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.register).not.toHaveBeenCalled();
      turn.resolve(response(hasSummary ? summaryA : null));
      await waitFor(() => {
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
        if (hasSummary) {
          expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryA }));
          expect(context.app.lastFrame()).toContain('Goal registered');
        } else {
          expect(context.call).toHaveBeenCalledTimes(2);
          expect(context.app.lastFrame()).toContain('Summary to register');
          expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
        }
      });
      expect(context.call).toHaveBeenCalledTimes(hasSummary ? 1 : 2);
      if (!hasSummary) {
        expect(context.call.mock.calls[1]![0]).toMatch(/summar/iu);
        expect(context.register).not.toHaveBeenCalled();
      }
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('queues /go during registration and never registers the consumed summary twice', async () => {
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSV出力を追加したい', summaryA);
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      context.call.mockResolvedValue(response(summaryB));
      await typeAndSubmit(context, '/go');
      await waitFor(() => expect(queuedFrame(context)).toContain('/go'));
      expect(context.call).toHaveBeenCalledOnce();
      registration.resolve(goalRecord());
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls[1]![0]).toMatch(/summar/iu);
        expect(context.app.lastFrame()).toContain('Summary to register');
        expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
        expect(queuedFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.register).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); registration.resolve(goalRecord()); await context.session.close(); }
  });

  it('waits for startup before processing queued /go', async () => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      await typeAndSubmit(context, '/go');
      await waitFor(() => expect(queuedFrame(context)).toContain('/go'));
      expect(context.call).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledOnce();
        expect(context.call.mock.calls[0]![0]).toMatch(/summar/iu);
        expect(context.app.lastFrame()).toContain('Summary to register');
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); recovery.resolve([]); await context.session.close(); }
  });

  it.each(['typed', 'pasted'] as const)('saves /go as a free-text answer without executing the command: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved' });
    try {
      await typeAndSubmit(context, '/answer');
      await enterSelection(context);
      await waitFor(() => expect(context.app.lastFrame()).toContain('Free text'));
      if (delivery === 'typed') for (const character of '/go') context.app.stdin.write(character);
      else context.app.stdin.write('\x1b[200~/go\x1b[201~');
      await waitFor(() => expect(promptFrame(context)).toContain('/go'));
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, questionId: target.question.id, text: '/go', abortSignal: expect.any(AbortSignal),
        });
        expect(context.app.lastFrame()).toContain('Answer saved');
      });
      expect(context.call).not.toHaveBeenCalled();
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('reports unavailable command input while retaining abort confirmation', async () => {
    memory.goals.mockReturnValue([goalRecord()]);
    const context = mount();
    const abort = vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Goal aborted' });
    try {
      await typeAndSubmit(context, '/abort');
      await enterSelection(context);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
      context.app.stdin.write('\x1b[200~/go\x1b[201~');
      await waitFor(() => {
        expect(context.app.lastFrame()).toMatch(/cannot.*(?:input|enter|type)|(?:input|command).*unavailable|finish.*confirmation/iu);
        expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
      });
      expect(context.call).not.toHaveBeenCalled();
      expect(context.register).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(abort).toHaveBeenCalledOnce());
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('shows insufficient material in %s and accepts the next conversation', async (lang) => {
    const context = mount(lang);
    const structuredOutput = { message: lang === 'ja' ? '作業の目的を教えてください。' : 'Please describe the objective.', summary: null };
    context.call.mockResolvedValueOnce({ ...response(null), structuredOutput })
      .mockResolvedValueOnce(response(null));
    try {
      await typeAndSubmit(context, '/go');
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain(structuredOutput.message);
        expect(context.app.lastFrame()).toMatch(lang === 'ja'
          ? /要約.*(?:でき|不足|ありません)|材料.*(?:不足|ありません)/u
          : /(?:cannot|could not|unable|not enough|insufficient).*summar|summar.*(?:unavailable|not available|not ready|insufficient)/iu);
        expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      expect(context.session.getPendingSummary()).toBeNull();
      expect(context.register).not.toHaveBeenCalled();
      expect(context.call).toHaveBeenCalledOnce();
      await typeAndSubmit(context, 'CSVを出力したい');
      await waitFor(() => expect(context.call).toHaveBeenCalledTimes(2));
      expect(context.call.mock.calls[1]![0]).toBe('CSVを出力したい');
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('shows localized /go help for requesting and approving a summary in %s', async (lang) => {
    const context = mount(lang);
    try {
      await waitFor(() => {
        const help = context.app.lastFrame()!.replace(/\s+/gu, ' ');
        expect(help).toContain('/go');
        expect(help).toMatch(lang === 'ja' ? /要約/u : /summar/iu);
        expect(help).toMatch(lang === 'ja' ? /承認|登録/u : /approv|register/iu);
      });
      expect(context.call).not.toHaveBeenCalled();
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });
});


describe('manager TUI human approval', () => {
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
