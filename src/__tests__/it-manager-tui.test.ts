import { QUESTION_MENU, SUMMARY_MENU, selectionFrame, openMenu, chooseGoalAction, enterSelection, memory, failureNotice, cwd, summaryA, summaryB, ENTER, UP, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit, send, approve } from './helpers/manager-tui-fixtures.js';
import './helpers/manager-tui-input.js';
import './helpers/manager-tui-startup.js';
import './helpers/manager-tui-selection.js';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import * as savedEvents from '../features/manager/savedEvents.js';
import { toDisplayText } from '../features/tui/displayText.js';
import { createGoal } from '../infra/goals/service.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

describe('manager TUI summary menu and conversation input', () => {
  it.each(['request', 'register'] as const)('keeps a queued summary %s on menu Esc and discards it on ordinary Esc', async (operation) => {
    for (const closeMenu of [false, true]) {
      const empty = { events: [], diagnostics: [], goals: [goalRecord()], questions: [] };
      const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(empty);
      const turn = deferred<ReturnType<typeof response>>();
      const refresh = deferred<typeof empty>();
      const context = mount();
      const approval = vi.spyOn(context.session, 'approveSummary');
      context.call.mockImplementationOnce(async () => {
        await turn.promise;
        if (operation === 'register') read.mockReturnValueOnce(refresh.promise);
        return response(operation === 'register' ? summaryA : null);
      }).mockResolvedValue(response(summaryB));
      try {
        await typeAndSubmit(context, 'First conversation');
        await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
        const signal = context.call.mock.calls[0]![1].abortSignal!;
        if (operation === 'register') {
          turn.resolve(response(summaryA));
          await waitFor(() => expect(context.app.lastFrame()).toContain('Summary to register'));
        }
        const revision = context.session.getPendingSummary()?.revision;
        context.app.stdin.write(SUMMARY_MENU);
        if (closeMenu) {
          await openMenu(context, 'goal');
          await waitFor(() => expect(selectionFrame(context)).toBeDefined());
        }
        context.app.stdin.write('\x1b[27u');
        await waitFor(() => {
          expect(selectionFrame(context)).toBeUndefined();
          if (operation === 'request' || closeMenu) expect(signal.aborted).toBe(!closeMenu);
        });
        turn.resolve(response(null));
        refresh.resolve(empty);
        await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
        if (!closeMenu) {
          expect(context.call).toHaveBeenCalledOnce();
          expect(approval).not.toHaveBeenCalled();
        } else if (operation === 'request') {
          await waitFor(() => expect(context.session.getPendingSummary()?.summary).toEqual(summaryB));
          expect(context.call).toHaveBeenCalledTimes(2);
          expect(context.call.mock.calls[1]![0]).toBe(getLabel('manager.goSummaryRequest', 'en'));
          expect(approval).not.toHaveBeenCalled();
        } else {
          await waitFor(() => expect(approval).toHaveBeenCalledExactlyOnceWith(revision));
          expect(context.register).toHaveBeenCalledOnce();
          expect(context.call).toHaveBeenCalledOnce();
        }
      } finally { context.app.unmount(); turn.resolve(response(null)); refresh.resolve(empty); await context.session.close(); read.mockRestore(); }
    }
  });

  it.each([false, true])('checks registration again when the inquiry snapshot arrives (registration finished=%s)', async (finished) => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const, status: 'pending' as const, body: 'Choose output',
    } };
    const snapshot = { events: [], diagnostics: [], goals: [goalRecord()], questions: [target] };
    const menuSnapshot = { ...snapshot, questions: [target, { ...target, question: { ...target.question, id: '650e8400-e29b-41d4-a716-446655440002' } }] };
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot);
    const refresh = deferred<typeof snapshot>();
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSV export', summaryA);
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      read.mockReturnValueOnce(refresh.promise);
      const before = read.mock.calls.length;
      context.app.stdin.write(QUESTION_MENU);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
      context.app.stdin.write(SUMMARY_MENU);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      context.app.stdin.write('kept draft');
      await waitFor(() => expect(promptFrame(context)).toContain('kept draft'));
      if (finished) {
        registration.resolve(goalRecord());
        await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      }
      read.mockResolvedValue(menuSnapshot);
      refresh.resolve(menuSnapshot);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('Pending 2');
        expect(selectionFrame(context) !== undefined).toBe(finished);
        expect(promptFrame(context)).toContain('kept draft');
      });
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); registration.resolve(goalRecord()); refresh.resolve(snapshot); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('switches the input hint with summary selection and conversation in the same %s screen', async (lang) => {
    const context = mount(lang);
    const sendHint = lang === 'ja' ? 'Enter 送信' : 'Enter Send';
    const selectHint = lang === 'ja' ? /Enter.*決定/u : /Enter.*(?:Select|Confirm)/iu;
    try {
      await waitFor(() => expect(promptFrame(context)).toContain(sendHint));
      await send(context, 'CSV export', summaryA);
      await waitFor(() => {
        expect(promptFrame(context)).toMatch(selectHint);
        expect(promptFrame(context)).not.toContain(sendHint);
      });
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(context.session.getPendingSummary()).toBeNull();
        expect(promptFrame(context)).toContain(sendHint);
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('requests a summary through Ctrl+O in the existing %s conversation', async (lang) => {
    const context = mount(lang);
    context.call.mockResolvedValueOnce({ ...response(null), sessionId: 'manager-conversation' })
      .mockResolvedValueOnce(response(summaryB));
    try {
      await typeAndSubmit(context, 'JSON出力について相談したい');
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledOnce();
        expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      context.app.stdin.write(SUMMARY_MENU);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.app.lastFrame()).toContain(lang === 'ja' ? '登録する要約' : 'Summary to register');
        expect(context.app.lastFrame()).toContain(summaryB.objective);
        expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      const [request, options] = context.call.mock.calls[1]!;
      expect(request).toBe(getLabel('manager.goSummaryRequest', lang));
      expect(options.sessionId).toBe('manager-conversation');
      expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('registers the displayed summary through Ctrl+O without regenerating it in %s', async (lang) => {
    const context = mount(lang);
    const approval = vi.spyOn(context.session, 'approveSummary');
    try {
      context.call.mockResolvedValueOnce(response(summaryB));
      await send(context, 'JSONを出力したい', summaryB);
      await waitFor(() => expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working'));
      const revision = context.session.getPendingSummary()!.revision;
      context.app.stdin.write(SUMMARY_MENU);
      await waitFor(() => {
        expect(context.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summaryB }));
        expect(context.app.lastFrame()).not.toContain(lang === 'ja' ? '処理中' : 'Working');
      });
      const goal = await context.register.mock.results[0]!.value;
      expect(context.app.lastFrame()).toContain(summaryB.objective);
      expect(context.app.lastFrame()).toContain(goal.id);
      expect(context.app.lastFrame()).toContain(goal.branch);
      expect(approval).toHaveBeenCalledExactlyOnceWith(revision);
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.session.getPendingSummary()).toBeNull();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([
    '/go', '  /go  ', '\t/go\t', '/go extra', '/go\textra',
    '/answer', '/answer 進捗を教えて', '/pause', '/pause ID', '/resume', '/resume ID', '/abort', '/abort ID',
    '/goal', '`/go`', '> /go', '説明 /go', '```\n/go\n```', '/go\n続き',
  ])('sends slash-prefixed or quoted text unchanged as conversation: %j', async (text) => {
    const context = mount();
    context.call.mockResolvedValue(response(null));
    const message = vi.spyOn(context.session, 'handleUserMessage');
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(`\x1b[200~${text}\x1b[201~`);
      await waitFor(() => expect(promptFrame(context)).toContain(text.split('\n')[0]!.replace(/\t/gu, ' ')));
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(message).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
        expect(context.call).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object));
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(context.register).not.toHaveBeenCalled();
      expect(context.app.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en'));
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('sends /go as conversation after a summary is displayed without registering a goal', async () => {
    const context = mount();
    try {
      await send(context, 'CSVを出力したい', summaryA);
      context.call.mockResolvedValueOnce(response(null));
      context.app.stdin.write('/go');
      await waitFor(() => {
        expect(promptFrame(context)).toContain('/go');
        expect(context.session.getPendingSummary()).toBeNull();
      });
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.call).toHaveBeenLastCalledWith('/go', expect.any(Object)));
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([
    { label: 'ordinary text', input: '修正', newline: false },
    { label: 'slash text', input: '/g', newline: false },
    { label: 'shift newline', input: '\x1b[13;2u', newline: true },
    { label: 'meta newline', input: '\x1b[13;3u', newline: true },
  ])('dismisses the summary when editing $label', async ({ input, newline }) => {
    const context = mount();
    try {
      await send(context, 'CSVを出力したい', summaryA);
      if (newline) context.app.stdin.write(UP);
      context.app.stdin.write(input);
      await waitFor(() => {
        expect(context.session.getPendingSummary()).toBeNull();
        expect(context.app.lastFrame()).not.toContain('Summary to register');
      });
      expect(context.register).not.toHaveBeenCalled();
      expect(context.call).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps the ordinary cursor editing behavior for slash-prefixed text', async () => {
    const level = chalk.level;
    chalk.level = 1;
    const context = mount();
    context.call.mockResolvedValue(response(null));
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write('/go');
      await waitFor(() => expect(promptFrame(context)).toContain('/go\x1b[7m \x1b[27m'));
      context.app.stdin.write('\x1b[D');
      await waitFor(() => expect(promptFrame(context)).toContain('/g\x1b[7mo\x1b[27m'));
      context.app.stdin.write('\x1b[C');
      context.app.stdin.write('\x7f');
      await waitFor(() => expect(stripVTControlCharacters(promptFrame(context))).toContain('/g'));
      context.app.stdin.write('o');
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('/go', expect.any(Object)));
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); chalk.level = level; }
  });

  it.each([false, true])('queues a summary request during a turn without approving the arriving summary=%s', async (hasSummary) => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(summaryB));
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      context.app.stdin.write('あとで');
      await waitFor(() => expect(promptFrame(context)).toContain('あとで'));
      context.app.stdin.write(SUMMARY_MENU);
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.register).not.toHaveBeenCalled();
      turn.resolve(response(hasSummary ? summaryA : null));
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
        expect(promptFrame(context)).toContain('あとで');
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(context.call.mock.calls[1]![0]).toBe(getLabel('manager.goSummaryRequest', 'en'));
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('waits for startup before processing a summary menu request', async () => {
    const recovery = deferred<readonly string[]>();
    const startup = { run: vi.fn(() => recovery.promise), fail: vi.fn() };
    const context = mount('en', startup);
    try {
      await waitFor(() => expect(startup.run).toHaveBeenCalledOnce());
      context.app.stdin.write(SUMMARY_MENU);
      context.app.stdin.write('startup draft');
      await waitFor(() => expect(promptFrame(context)).toContain('startup draft'));
      expect(context.call).not.toHaveBeenCalled();
      recovery.resolve([]);
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith(getLabel('manager.goSummaryRequest', 'en'), expect.any(Object));
        expect(context.session.getPendingSummary()?.summary).toEqual(summaryA);
        expect(promptFrame(context)).toContain('startup draft');
      });
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); recovery.resolve([]); await context.session.close(); }
  });

  it('queues a new summary request during registration without registering the consumed summary twice', async () => {
    const registration = deferred<Awaited<ReturnType<typeof createGoal>>>();
    const context = mount();
    context.register.mockReturnValueOnce(registration.promise);
    try {
      await send(context, 'CSVを出力したい', summaryA);
      context.app.stdin.write(SUMMARY_MENU);
      await waitFor(() => expect(context.register).toHaveBeenCalledOnce());
      context.call.mockResolvedValueOnce(response(summaryB));
      context.app.stdin.write(SUMMARY_MENU);
      context.app.stdin.write('registration draft');
      await waitFor(() => expect(promptFrame(context)).toContain('registration draft'));
      expect(context.call).toHaveBeenCalledOnce();
      registration.resolve(goalRecord());
      await waitFor(() => {
        expect(context.call).toHaveBeenCalledTimes(2);
        expect(context.call.mock.calls[1]![0]).toBe(getLabel('manager.goSummaryRequest', 'en'));
        expect(context.session.getPendingSummary()?.summary).toEqual(summaryB);
        expect(promptFrame(context)).toContain('registration draft');
      });
      expect(context.register).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); registration.resolve(goalRecord()); await context.session.close(); }
  });

  it.each(['escape', 'exit', 'unmount'] as const)('discards a waiting summary request on %s', async (action) => {
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise);
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      context.app.stdin.write(SUMMARY_MENU);
      if (action === 'unmount') context.app.unmount();
      else context.app.stdin.write(action === 'exit' ? '\x03' : '\x1b[27u');
      await waitFor(() => expect(context.call.mock.calls[0]![1].abortSignal!.aborted).toBe(true));
      turn.resolve(response(null));
      await context.session.close();
      expect(context.call).toHaveBeenCalledOnce();
      expect(context.register).not.toHaveBeenCalled();
      if (action === 'exit') expect(context.onExit).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it.each(['typed', 'pasted'] as const)('saves /go as a free-text answer without executing the command: %s', async (delivery) => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Answer fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const,
      status: 'pending' as const, body: 'Which output format?', options: ['CSV', 'JSON'],
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => expect(context.app.lastFrame()).toContain('Free text'));
      if (delivery === 'typed') for (const character of '/go') context.app.stdin.write(character);
      else context.app.stdin.write('\x1b[200~/go\x1b[201~');
      await waitFor(() => expect(promptFrame(context)).toContain('/go'));
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(answer).toHaveBeenCalledExactlyOnceWith({
          goalId: target.goalId, repositoryDirectory: cwd, questionId: target.question.id, answer: { text: '/go' }, abortSignal: expect.any(AbortSignal),
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
      await openMenu(context, 'goal');
      await enterSelection(context);
      await chooseGoalAction(context, 'abort');
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
      context.app.stdin.write(SUMMARY_MENU);
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
