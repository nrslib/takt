import { QUESTION_MENU, GOAL_MENU, openMenu, chooseGoalAction, selectionFrame, enterSelection, cwd, ENTER, UP, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit } from './manager-tui-fixtures.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as savedEvents from '../../features/manager/savedEvents.js';
import { formatGoalName } from '../../features/manager/goalDisplay.js';
import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import { goalRecord } from './goal-fixtures.js';

const DOWN = '\x1b[B';
const ESC = '\x1b[27u';
const id = (index: number): string => `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`;
const inquiry = (index: number, overrides: Partial<GoalQuestion> = {}): GoalQuestion => ({
  id: id(index), recipient: 'human', status: 'pending', body: `Inquiry ${index}`, ...overrides,
});

function snapshot(goals: Goal[]) {
  return { events: [], diagnostics: [], notices: [], goals,
    questions: goals.flatMap((goal) => (goal.questions ?? [])
      .filter((question) => question.status === 'pending' && question.recipient === 'human')
      .map((question) => ({ goalId: goal.id, repositoryDirectory: cwd, objective: goal.objective, question }))),
  };
}

async function expectList(context: ReturnType<typeof mount>): Promise<string> {
  await vi.waitFor(() => expect(selectionFrame(context)).toBeDefined(), { timeout: 1500 });
  return selectionFrame(context)!;
}

function operations(context: ReturnType<typeof mount>) {
  return {
    pause: vi.spyOn(context.session, 'pauseGoal').mockResolvedValue({ kind: 'reply', message: 'Pause completed' }),
    resume: vi.spyOn(context.session, 'resumeGoal').mockResolvedValue({ kind: 'reply', message: 'Resume completed' }),
    abort: vi.spyOn(context.session, 'abortGoal').mockResolvedValue({ kind: 'reply', message: 'Abort completed' }),
    answer: vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer completed', answerSaved: true }),
  };
}

describe('manager command selection', () => {
  it.each(['active', 'paused'] as const)('offers only meaningful operations for an %s goal', async (executionStatus) => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([{ ...goalRecord(), executionStatus }]));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'goal');
      await enterSelection(context);
      await vi.waitFor(() => {
        const menu = selectionFrame(context);
        expect(menu).toBeDefined();
        const rows = menu!.split('\n').slice(2, -2);
        expect(rows.filter((row) => /pause|resume|abort/iu.test(row))).toHaveLength(2);
        expect(rows.some((row) => /abort/iu.test(row))).toBe(true);
        expect(rows.some((row) => (executionStatus === 'active' ? /pause/iu : /resume/iu).test(row))).toBe(true);
        expect(rows.some((row) => (executionStatus === 'active' ? /resume/iu : /pause/iu).test(row))).toBe(false);
      });
      context.app.stdin.write(ESC);
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['active', 'paused'] as const)('revalidates a formerly %s goal without substituting the opposite operation', async (executionStatus) => {
    let goal: Goal = { ...goalRecord(), executionStatus };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockImplementation(async () => snapshot([goal]));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'goal');
      await enterSelection(context);
      await vi.waitFor(() => expect(selectionFrame(context)).toMatch(/abort/iu));
      goal = { ...goal, executionStatus: executionStatus === 'active' ? 'paused' : 'active' };
      await chooseGoalAction(context, executionStatus === 'active' ? 'pause' : 'resume');
      await vi.waitFor(() => {
        expect(context.app.lastFrame()).toContain(getLabel('manager.selectionChanged', 'en'));
        expect(selectionFrame(context)).toContain(formatGoalName(goal.objective));
        expect(selectionFrame(context)).toMatch(goal.executionStatus === 'active' ? /active/iu : /paused/iu);
      });
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([
    { command: 'pause', remaining: true, confirm: false },
    { command: 'pause', remaining: false, confirm: false },
    { command: 'resume', remaining: true, confirm: false },
    { command: 'abort', remaining: true, confirm: false },
    { command: 'abort', remaining: true, confirm: true },
  ] as const)('rechecks $command eligibility on Enter (remaining=$remaining, confirm=$confirm)', async ({ command, remaining, confirm }) => {
    const executionStatus = command === 'resume' ? 'paused' : 'active';
    const first: Goal = { ...goalRecord(), id: id(1), objective: 'Selected candidate', executionStatus };
    const second: Goal = { ...first, id: id(2), objective: 'Remaining candidate' };
    let goals = remaining ? [first, second] : [first];
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockImplementation(async () => snapshot(goals));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'goal');
      await expectList(context);
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(selectionFrame(context)).toMatch(/abort/iu));
      if (confirm) {
        await chooseGoalAction(context, command);
        await vi.waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
        context.app.stdin.write(UP);
      }
      const changed: Goal = { ...first, status: 'completed' };
      goals = remaining ? [changed, second] : [changed];
      const before = read.mock.calls.length;
      if (confirm) context.app.stdin.write(ENTER);
      else await chooseGoalAction(context, command);
      await vi.waitFor(() => {
        expect(read.mock.calls.length).toBeGreaterThan(before);
        expect(context.app.lastFrame()).toContain(getLabel('manager.selectionChanged', 'en'));
        if (remaining) {
          expect(selectionFrame(context)).toContain(second.objective);
          expect(selectionFrame(context)).not.toContain(first.objective);
        } else {
          expect(selectionFrame(context)).toBeUndefined();
          expect(context.app.lastFrame()).toMatch(/no.*(?:goals|targets)/iu);
        }
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
      });
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      expect(goals[0]).toEqual(changed);
      if (remaining) {
        context.app.stdin.write(ENTER);
        await chooseGoalAction(context, command);
        if (command === 'abort') {
          await vi.waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
          context.app.stdin.write(UP);
          context.app.stdin.write(ENTER);
        }
        await vi.waitFor(() => expect(calls[command]).toHaveBeenCalledExactlyOnceWith({ goalId: second.id, abortSignal: expect.any(AbortSignal) }));
      }
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['pause', 'resume', 'abort'] as const)('lists only eligible %s goals and executes the second selected goal', async (command) => {
    const validStatus = command === 'resume' ? 'paused' : 'active';
    const goals: Goal[] = [
      { ...goalRecord(), id: id(1), objective: 'First candidate', executionStatus: validStatus },
      { ...goalRecord(), id: id(2), objective: 'Second candidate', executionStatus: command === 'abort' ? 'paused' : validStatus },
      { ...goalRecord(), id: id(3), objective: 'Already completed', status: 'completed', executionStatus: validStatus },
      { ...goalRecord(), id: id(4), objective: 'Already aborted', executionStatus: 'aborted' },
    ];
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot(goals));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'goal');
      const list = await expectList(context);
      const rows = list.split('\n');
      for (const goal of goals.slice(0, 2)) {
        const matches = rows.filter((row) => row.includes(goal.objective));
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatch(/active|paused/iu);
      }
      for (const goal of goals.slice(2)) expect(list).not.toContain(goal.objective);
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      context.app.stdin.write(DOWN);
      context.app.stdin.write(UP);
      context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      await chooseGoalAction(context, command);
      if (command === 'abort') {
        await vi.waitFor(() => expect(context.app.lastFrame()?.replace(/[│\s]+/gu, ''))
          .toContain(getLabel('manager.abortWarning', 'en').replace(/\s+/gu, '')));
        expect(calls.abort).not.toHaveBeenCalled();
        context.app.stdin.write(UP);
        context.app.stdin.write(ENTER);
      }
      await vi.waitFor(() => expect(calls[command]).toHaveBeenCalledExactlyOnceWith({ goalId: id(2), abortSignal: expect.any(AbortSignal) }));
      for (const [name, call] of Object.entries(calls)) if (name !== command) expect(call).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('opens details only for the selected inquiry and preserves identity when short names and question IDs collide', async () => {
    const objective = 'A shared goal name that is deliberately longer than the display limit';
    const goals: Goal[] = [1, 2].map((index) => ({ ...goalRecord(), id: id(index), objective: `${objective} ${index}`,
      questions: [inquiry(10, { kind: index === 1 ? 'approval' : 'question', body: `Summary ${index}\n${'details '.repeat(10)}DETAIL ${index}`,
        operation: index === 1 ? { toolName: 'Write', args: '{}', cwd: '/test/manager-repository',
          argsDigest: createHash('sha256').update('{}').digest('hex') } : undefined,
        options: [`Option ${index}`, `Other ${index}`], recommendation: `Recommendation ${index}` })],
    }));
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot(goals));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'answer');
      const list = await expectList(context);
      expect(list.split('\n').filter((row) => row.includes(formatGoalName(objective)))).toHaveLength(2);
      expect(list).toMatch(/question/iu);
      expect(list).toMatch(/approval/iu);
      for (const index of [1, 2]) {
        expect(list).toContain(`Summary ${index}`);
        expect(list).not.toContain(`DETAIL ${index}`);
        expect(list).not.toContain(`Option ${index}`);
        expect(list).not.toContain(`Recommendation ${index}`);
      }
      context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(context.app.lastFrame()?.replace(/[│\s]+/gu, '')).toContain(goals[1]!.questions![0]!.body.replace(/\s+/gu, ''));
        expect(context.app.lastFrame()).toContain('Option 2');
        expect(context.app.lastFrame()).toContain('Recommendation 2');
      });
      expect(calls.answer).not.toHaveBeenCalled();
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(calls.answer).toHaveBeenCalledExactlyOnceWith({
        goalId: id(2), repositoryDirectory: cwd, questionId: id(10), answer: { text: 'Option 2' }, abortSignal: expect.any(AbortSignal),
      }));
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['answer', 'goal'] as const)('closes the %s list on Esc without any answer or goal operation', async (command) => {
    const goals: Goal[] = [{ ...goalRecord(), executionStatus: 'active', questions: [inquiry(1)] }];
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot(goals));
    const context = mount();
    const calls = operations(context);
    context.call.mockResolvedValue(response(null));
    try {
      await openMenu(context, command === 'answer' ? 'answer' : 'goal');
      await expectList(context);
      context.app.stdin.write(ESC);
      await vi.waitFor(() => expect(selectionFrame(context)).toBeUndefined());
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      await typeAndSubmit(context, 'Conversation after closing list');
      await vi.waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      expect(context.call.mock.calls[0]![0]).toBe('Conversation after closing list');
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['answer', 'goal'] as const)('reports no eligible %s targets without opening a list', async (command) => {
    const goals: Goal[] = [
      { ...goalRecord(), id: id(1), status: 'completed', executionStatus: 'active' },
      { ...goalRecord(), id: id(2), status: 'completed', executionStatus: 'paused' },
      { ...goalRecord(), id: id(3), executionStatus: 'aborted' },
    ];
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot(goals));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, command === 'answer' ? 'answer' : 'goal');
      await vi.waitFor(() => {
        expect(context.app.lastFrame()).toMatch(/no.*(?:pending|inquiries|questions|goals|targets)/iu);
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(queuedFrame(context)).toBeUndefined();
      }, { timeout: 1500 });
      expect(selectionFrame(context)).toBeUndefined();
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([
    '操作例: /pause ID', '> /pause ID', '`/pause ID`', '/paused ID',
    '```text\n/pause ID\n```', '~~~text\n/pause ID\n~~~',
    '```text\n> ~~~\n/pause ID\n~~~\n```', '```\n/pause ID',
  ])('sends command examples unchanged as ordinary conversation: %j', async (text) => {
    const context = mount();
    const calls = operations(context);
    context.call.mockResolvedValue(response(null));
    try {
      context.app.stdin.write(`\x1b[200~${text}\x1b[201~`);
      await vi.waitFor(() => expect(promptFrame(context)).toContain(text.split('\n')[0]!));
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith(text, expect.any(Object)));
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      expect(selectionFrame(context)).toBeUndefined();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('saves a slash command as a free-text answer without pausing the goal', async () => {
    const goal: Goal = { ...goalRecord(), questions: [inquiry(1, { body: '保存先を指定してください' })] };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goal]));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await vi.waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      const text = `/pause ${goal.id}`;
      context.app.stdin.write(text);
      await vi.waitFor(() => expect(promptFrame(context)).toContain(text));
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(calls.answer).toHaveBeenCalledExactlyOnceWith({
        goalId: goal.id, repositoryDirectory: cwd, questionId: id(1), answer: { text }, abortSignal: expect.any(AbortSignal),
      }));
      expect(calls.pause).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('opens the pause list from ordinary input while an inquiry is pending without saving an answer', async () => {
    const goal: Goal = { ...goalRecord(), questions: [inquiry(1)] };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goal]));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'goal');
      expect(await expectList(context)).toContain(formatGoalName(goal.objective));
      expect(calls.answer).not.toHaveBeenCalled();
      expect(calls.pause).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps the selected inquiry when a new inquiry arrives in the same screen', async () => {
    let goals: Goal[] = [{ ...goalRecord(), questions: [inquiry(1), inquiry(2)] }];
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockImplementation(async () => snapshot(goals));
    const context = mount();
    const calls = operations(context);
    try {
      await openMenu(context, 'answer');
      await expectList(context);
      context.app.stdin.write(DOWN);
      const beforePolls = read.mock.calls.length;
      goals = [{ ...goals[0]!, questions: [inquiry(3, { body: 'New arrival' }), ...goals[0]!.questions!] }];
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(beforePolls));
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      context.app.stdin.write('Selected answer');
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(calls.answer).toHaveBeenCalledExactlyOnceWith({
        goalId: goals[0]!.id, repositoryDirectory: cwd, questionId: id(2), answer: { text: 'Selected answer' }, abortSignal: expect.any(AbortSignal),
      }));
    } finally { context.app.unmount(); await context.session.close(); }
  });
});

describe('manager TUI selection queue', () => {
  it.each(['pause', 'resume', 'abort'] as const)('keeps a queued %s when closing another menu but cancels it on ordinary Esc', async (command) => {
    for (const closeMenu of [false, true]) {
      const goal: Goal = { ...goalRecord(), executionStatus: command === 'resume' ? 'paused' : 'active', questions: [inquiry(1)] };
      const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goal]));
      const turn = deferred<ReturnType<typeof response>>();
      const context = mount();
      const calls = operations(context);
      context.call.mockReturnValueOnce(turn.promise);
      try {
        await typeAndSubmit(context, 'First conversation');
        await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
        const signal = context.call.mock.calls[0]![1].abortSignal!;
        await openMenu(context, 'goal');
        await enterSelection(context);
        await chooseGoalAction(context, command);
        await waitFor(() => expect(selectionFrame(context)).toBeUndefined());
        if (closeMenu) {
          await openMenu(context, command === 'pause' ? 'answer' : 'goal');
          await expectList(context);
          if (command === 'abort') {
            await enterSelection(context);
            await waitFor(() => expect(selectionFrame(context)).toMatch(/abort/iu));
          }
        }
        context.app.stdin.write(ESC);
        await waitFor(() => {
          expect(selectionFrame(context)).toBeUndefined();
          expect(signal.aborted).toBe(!closeMenu);
        });
        turn.resolve(response(null));
        await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
        if (closeMenu) {
          if (command === 'abort') {
            await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
            expect(calls.abort).not.toHaveBeenCalled();
            context.app.stdin.write(UP);
            context.app.stdin.write(ENTER);
          }
          await waitFor(() => expect(calls[command]).toHaveBeenCalledExactlyOnceWith({ goalId: goal.id, abortSignal: expect.any(AbortSignal) }));
        } else {
          expect(calls[command]).not.toHaveBeenCalled();
          expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
        }
      } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); read.mockRestore(); }
    }
  });

  it('invalidates a delayed replacement menu when Esc closes the visible menu', async () => {
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([{ ...goalRecord(), questions: [inquiry(1)] }]));
    const context = mount();
    const refresh = deferred<Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>>>();
    try {
      await openMenu(context, 'answer');
      await expectList(context);
      read.mockReturnValueOnce(refresh.promise);
      const before = read.mock.calls.length;
      context.app.stdin.write(GOAL_MENU);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
      context.app.stdin.write(ESC);
      await waitFor(() => expect(selectionFrame(context)).toBeUndefined());
      refresh.resolve(snapshot([goalRecord()]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(selectionFrame(context)).toBeUndefined();
      await openMenu(context, 'goal');
      await expectList(context);
    } finally { context.app.unmount(); refresh.resolve(snapshot([])); await context.session.close(); }
  });

  it('does not reopen a menu after Esc cancels its pending display refresh', async () => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([
      { ...goalRecord(), questions: [inquiry(1)] },
    ]));
    const context = mount();
    const refresh = deferred<Awaited<ReturnType<typeof context.session.getAssignment>>>();
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      const assignment = vi.spyOn(context.session, 'getAssignment').mockReturnValue(refresh.promise);
      context.app.stdin.write(QUESTION_MENU);
      await waitFor(() => expect(assignment).toHaveBeenCalled());
      context.app.stdin.write(ESC);
      refresh.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(selectionFrame(context)).toBeUndefined();
      expect(context.call).not.toHaveBeenCalled();
      assignment.mockRestore();
      await openMenu(context, 'answer');
      await expectList(context);
    } finally { context.app.unmount(); refresh.resolve(undefined); await context.session.close(); }
  });

  it.each(['complete', 'escape', 'unmount'] as const)('guards the eligibility refresh through %s and retains input', async (action) => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goalRecord()]));
    const context = mount();
    const calls = operations(context);
    const refresh = deferred<Awaited<ReturnType<typeof context.session.getAssignment>>>();
    context.call.mockResolvedValue(response(null));
    try {
      await openMenu(context, 'goal');
      await expectList(context);
      context.app.stdin.write(ENTER);
      await expectList(context);
      const assignment = vi.spyOn(context.session, 'getAssignment').mockReturnValue(refresh.promise);
      await chooseGoalAction(context, 'pause');
      await vi.waitFor(() => expect(assignment).toHaveBeenCalled());
      context.app.stdin.write(ENTER);
      await typeAndSubmit(context, 'Conversation after refresh');
      context.app.stdin.write('Draft during refresh');
      await vi.waitFor(() => {
        expect(queuedFrame(context)).toContain('Conversation after refresh');
        expect(promptFrame(context)).toContain('Draft during refresh');
      });
      expect(calls.pause).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
      if (action === 'escape') context.app.stdin.write(ESC);
      else if (action === 'unmount') context.app.unmount();
      refresh.resolve(undefined);
      if (action === 'unmount') await new Promise<void>((resolve) => setImmediate(resolve));
      else await vi.waitFor(() => {
        expect(context.app.lastFrame()).not.toContain('Working');
        expect(promptFrame(context)).toContain('Draft during refresh');
        expect(queuedFrame(context)).toBeUndefined();
        if (action === 'complete') expect(context.call).toHaveBeenCalledExactlyOnceWith('Conversation after refresh', expect.any(Object));
      });
      if (action === 'complete') expect(calls.pause).toHaveBeenCalledExactlyOnceWith({ goalId: goalRecord().id, abortSignal: expect.any(AbortSignal) });
      else {
        expect(calls.pause).not.toHaveBeenCalled();
        expect(context.call).not.toHaveBeenCalled();
      }
    } finally { context.app.unmount(); refresh.resolve(undefined); await context.session.close(); }
  });

  it('clears successful abort confirmation before a subsequent display refresh fails', async () => {
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goalRecord()]));
    const context = mount();
    const calls = operations(context);
    calls.abort.mockImplementation(async () => {
      read.mockRejectedValue(new Error('Post-abort refresh unavailable'));
      return { kind: 'reply', message: 'Abort completed' };
    });
    try {
      await openMenu(context, 'goal');
      await enterSelection(context);
      await chooseGoalAction(context, 'abort');
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
      context.app.stdin.write(UP);
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(context.app.lastFrame()).toContain('Abort completed');
        expect(context.app.lastFrame()).toContain('Post-abort refresh unavailable');
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
        expect(context.app.lastFrame()).not.toContain(getLabel('manager.retryAbort', 'en'));
        expect(context.app.lastFrame()).not.toContain('Working');
      });
      expect(calls.abort).toHaveBeenCalledOnce();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['answer', 'pause', 'resume', 'abort'] as const)('holds the following conversation while the %s list awaits selection', async (command) => {
    const goal: Goal = { ...goalRecord(), executionStatus: command === 'resume' ? 'paused' : 'active', questions: [inquiry(1)] };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goal]));
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    const calls = operations(context);
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    try {
      await typeAndSubmit(context, 'First conversation');
      await vi.waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'Conversation after list');
      await openMenu(context, command === 'answer' ? 'answer' : 'goal');
      turn.resolve(response(null));
      await expectList(context);
      expect(context.call).toHaveBeenCalledOnce();
      expect(queuedFrame(context)).toContain('Conversation after list');
      context.app.stdin.write(ESC);
      await vi.waitFor(() => expect(context.call.mock.calls.map(([text]) => text)).toEqual(['First conversation', 'Conversation after list']));
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('retains draft input and queued conversation while the selected pause operation is pending', async () => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goalRecord()]));
    const operation = deferred<Awaited<ReturnType<ReturnType<typeof mount>['session']['pauseGoal']>>>();
    const context = mount();
    const calls = operations(context);
    calls.pause.mockReturnValueOnce(operation.promise);
    context.call.mockResolvedValue(response(null));
    try {
      await openMenu(context, 'goal');
      await enterSelection(context);
      await chooseGoalAction(context, 'pause');
      await vi.waitFor(() => expect(calls.pause).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'Conversation after pause');
      context.app.stdin.write('Draft during pause');
      await vi.waitFor(() => {
        expect(promptFrame(context)).toContain('Draft during pause');
        expect(queuedFrame(context)).toContain('Conversation after pause');
      });
      expect(context.call).not.toHaveBeenCalled();
      operation.resolve({ kind: 'reply', message: 'Pause completed' });
      await vi.waitFor(() => {
        expect(context.call).toHaveBeenCalledExactlyOnceWith('Conversation after pause', expect.any(Object));
        expect(promptFrame(context)).toContain('Draft during pause');
        expect(queuedFrame(context)).toBeUndefined();
      });
    } finally { context.app.unmount(); operation.resolve({ kind: 'reply', message: 'Pause completed' }); await context.session.close(); }
  });
  it.each([ENTER, ESC])('cancels abort confirmation with %j before sending queued conversation', async (key) => {
    const turn = deferred<ReturnType<typeof response>>();
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([goalRecord()]));
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    const calls = operations(context);
    try {
      await typeAndSubmit(context, 'first request');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await typeAndSubmit(context, 'conversation after cancellation');
      await openMenu(context, 'goal');
      await enterSelection(context);
      await chooseGoalAction(context, 'abort');
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
        expect(context.call).toHaveBeenCalledOnce();
      });
      context.app.stdin.write(key);
      await waitFor(() => {
        expect(context.call.mock.calls.map(([text]) => text)).toEqual(['first request', 'conversation after cancellation']);
        expect(queuedFrame(context)).toBeUndefined();
      });
      expect(calls.abort).not.toHaveBeenCalled();
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it.each(['answer', 'goal'] as const)('opens and navigates the %s menu during a turn without losing the draft or aborting it', async (kind) => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([
      { ...goalRecord(), questions: [inquiry(1), inquiry(2)] },
    ]));
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount('ja');
    context.call.mockReturnValueOnce(turn.promise).mockResolvedValue(response(null));
    const calls = operations(context);
    try {
      await typeAndSubmit(context, '処理を続けて');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      const signal = context.call.mock.calls[0]![1].abortSignal!;
      context.app.stdin.write('あとで');
      await waitFor(() => expect(promptFrame(context)).toContain('あとで'));
      context.app.stdin.write(kind === 'answer' ? QUESTION_MENU : GOAL_MENU);
      await expectList(context);
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('処理中');
        expect(promptFrame(context)).toContain('あとで');
      });
      context.app.stdin.write(DOWN);
      context.app.stdin.write(UP);
      context.app.stdin.write(ESC);
      await waitFor(() => {
        expect(selectionFrame(context)).toBeUndefined();
        expect(context.app.lastFrame()).toContain('処理中');
        expect(promptFrame(context)).toContain('あとで');
      });
      expect(signal.aborted).toBe(false);
      turn.resolve(response(null));
      await waitFor(() => {
        expect(context.app.lastFrame()).not.toContain('処理中');
        expect(promptFrame(context)).toContain('あとで');
      });
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.call).toHaveBeenLastCalledWith('あとで', expect.any(Object)));
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('keeps conversation draft separate from the selected inquiry answer', async () => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([{ ...goalRecord(), questions: [inquiry(1)] }]));
    const context = mount();
    const calls = operations(context);
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write('Unsent conversation');
      await waitFor(() => expect(promptFrame(context)).toContain('Unsent conversation'));
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => {
        expect(promptFrame(context)).toContain('Enter your answer');
        expect(promptFrame(context)).not.toContain('Unsent conversation');
      });
      context.app.stdin.write('Only the answer');
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(calls.answer).toHaveBeenCalledWith(expect.objectContaining({ answer: { text: 'Only the answer' } }));
        expect(promptFrame(context)).toContain('Unsent conversation');
      });
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('opens the second inquiry during a turn and keeps its answer separate from an arriving summary', async () => {
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue(snapshot([
      { ...goalRecord(), questions: [inquiry(1), inquiry(2, { options: ['Second answer', 'Other answer'] })] },
    ]));
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    context.call.mockReturnValueOnce(turn.promise);
    const calls = operations(context);
    try {
      await typeAndSubmit(context, 'Continue the turn');
      await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      await openMenu(context, 'answer');
      await expectList(context);
      context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      await waitFor(() => {
        expect(promptFrame(context)).toContain('Enter your answer');
        expect(context.app.lastFrame()).toContain('Second answer');
        expect(context.app.lastFrame()).toContain('Working');
      });
      turn.resolve(response({ objective: 'New summary', outOfScope: [], acceptanceCriteria: ['Done'], constraints: [] }));
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(calls.answer).toHaveBeenCalledExactlyOnceWith({
        goalId: goalRecord().id, repositoryDirectory: cwd, questionId: id(2),
        answer: { text: 'Second answer' }, abortSignal: expect.any(AbortSignal),
      }));
      expect(context.register).not.toHaveBeenCalled();
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });
});
