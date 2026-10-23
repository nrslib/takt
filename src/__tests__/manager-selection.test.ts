import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagerSelectionDialog } from '../features/manager/ManagerSelectionDialog.js';
import { isGoalSelectionCandidate, useManagerSelection, type ManagerSelectedTarget } from '../features/manager/useManagerSelection.js';
import type { ManagerDisplayGoal } from '../features/manager/savedEvents.js';
import type { PendingQuestion } from '../features/manager/inquiryAnswer.js';
import { getLabel } from '../shared/i18n/index.js';

const goals: ManagerDisplayGoal[] = [
  { id: 'active-first', objective: 'First active', status: 'created', executionStatus: 'active' },
  { id: 'active-second', objective: 'Second active', status: 'awaiting_merge', executionStatus: 'active' },
  { id: 'paused-first', objective: 'First paused', status: 'created', executionStatus: 'paused' },
  { id: 'paused-second', objective: 'Second paused', status: 'created', executionStatus: 'paused' },
  { id: 'completed', objective: 'Completed', status: 'completed', executionStatus: 'active' },
  { id: 'aborted', objective: 'Aborted', status: 'created', executionStatus: 'aborted' },
];
const questions: PendingQuestion[] = [1, 2].map((index) => ({
  goalId: `goal-${index}`, repositoryDirectory: '/fixture', objective: `Inquiry goal ${index}`, question: {
    id: 'shared-question-id', recipient: 'human', status: 'pending', body: `Inquiry ${index}`,
  },
}));

function mount(snapshot = { goals, questions }, lang: 'en' | 'ja' = 'en') {
  const selected = vi.fn<(target: ManagerSelectedTarget) => void>();
  const opened = vi.fn<(result: boolean) => void>();
  function Probe() {
    const selection = useManagerSelection();
    useInput((input, key) => {
      if (input === 'o') opened(selection.open('answer', snapshot));
      else if (input === 'g') opened(selection.open('goal', snapshot));
      else selection.handleInput(key, selected);
    });
    return createElement(Box, { flexDirection: 'column', width: 120 },
      createElement(Text, {}, 'Selection probe'),
      selection.selection === null ? null : createElement(ManagerSelectionDialog, { selection: selection.selection, lang }));
  }
  return { app: render(createElement(Probe)), selected, opened };
}

const chalkLevel = chalk.level;
afterEach(() => { cleanup(); chalk.level = chalkLevel; });

it('selects the second inquiry with consecutive arrow and Enter input', async () => {
  const { app, selected, opened } = mount();
  app.stdin.write('o');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en')));
  expect(opened).toHaveBeenCalledWith(true);
  app.stdin.write('\x1b[A');
  app.stdin.write('\x1b[B');
  app.stdin.write('\r');
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'answer', target: questions[1] })));
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en')));
});

it.each(['ja', 'en'] as const)('renders a single row per inquiry with shared controls in %s and closes on Esc', async (lang) => {
  const { app, selected } = mount({ goals, questions }, lang);
  app.stdin.write('o');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionHint', lang)));
  expect(app.lastFrame()!.split('\n').filter((line) => line.includes('Inquiry goal'))).toHaveLength(2);
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Inquiry goal'));
  expect(selected).not.toHaveBeenCalled();
});

it('does not open an empty inquiry selection', async () => {
  const { app, opened, selected } = mount({ goals: goals.slice(4), questions: [] });
  app.stdin.write('o');
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(false));
  expect(app.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en'));
  expect(selected).not.toHaveBeenCalled();
});

it.each([
  { moves: 0, expected: 'pause', goal: goals[0] },
  { moves: 2, expected: 'resume', goal: goals[2] },
] as const)('selects the $expected operation after choosing an ongoing goal', async ({ moves, expected, goal }) => {
  const { app, selected } = mount();
  app.stdin.write('g');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en')));
  expect(app.lastFrame()!.split('\n').filter((line) => /First active|Second active|First paused|Second paused/u.test(line))).toHaveLength(4);
  expect(app.lastFrame()).not.toContain('Completed');
  expect(app.lastFrame()).not.toContain('Aborted');
  for (let move = 0; move < moves; move++) app.stdin.write('\x1b[B');
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.goalActions.abort', 'en')));
  expect(selected).not.toHaveBeenCalled();
  expect(app.lastFrame()).toContain(getLabel(`manager.goalActions.${expected}`, 'en'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith({ kind: expected, target: goal }));
});

it.each([
  { action: 'pause' as const, expected: ['active-first', 'active-second'] },
  { action: 'resume' as const, expected: ['paused-first', 'paused-second'] },
  { action: 'abort' as const, expected: ['active-first', 'active-second', 'paused-first', 'paused-second'] },
])('keeps the existing $action eligibility rule for operation-time revalidation', ({ action, expected }) => {
  expect(goals.filter((goal) => isGoalSelectionCandidate(action, goal)).map((goal) => goal.id)).toEqual(expected);
});

it.each(['answer', 'goal'] as const)('moves a ten-row %s window without changing the selected target', async (kind) => {
  const candidates = Array.from({ length: 12 }, (_, index) => `Candidate ${String(index + 1).padStart(2, '0')}`);
  const snapshot = {
    goals: candidates.map((objective, index) => ({ ...goals[0]!, id: `goal-${index}`, objective })),
    questions: candidates.map((objective, index) => ({ question: questions[0]!.question, repositoryDirectory: '/fixture', goalId: `goal-${index}`, objective })),
  };
  const { app, selected } = mount(snapshot);
  const visible = (): string[] => app.lastFrame()!.split('\n').filter((row) => row.includes('Candidate '));
  app.stdin.write(kind === 'answer' ? 'o' : 'g');
  await vi.waitFor(() => expect(visible()).toHaveLength(10));
  for (const name of candidates.slice(0, 10)) expect(visible().some((row) => row.includes(name))).toBe(true);
  for (let move = 0; move < 10; move++) app.stdin.write('\x1b[B');
  await vi.waitFor(() => {
    expect(visible()).toHaveLength(10);
    expect(visible().some((row) => row.includes(candidates[10]!))).toBe(true);
    expect(visible().some((row) => row.includes(candidates[0]!))).toBe(false);
  });
  app.stdin.write('\r');
  if (kind === 'goal') {
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.goalActions.pause', 'en')));
    app.stdin.write('\r');
  }
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: kind === 'answer' ? 'answer' : 'pause',
    target: kind === 'answer' ? snapshot.questions[10] : snapshot.goals[10],
  })));
});

it.each(['answer', 'goal'] as const)('keeps the %s window still until the selection crosses its top edge', async (kind) => {
  chalk.level = 1;
  const snapshot = {
    goals: Array.from({ length: 12 }, (_, index) => ({ ...goals[0]!, id: `goal-${index}`, objective: `Row ${String(index).padStart(2, '0')}` })),
    questions: Array.from({ length: 12 }, (_, index) => ({ question: questions[0]!.question, repositoryDirectory: '/fixture', goalId: `goal-${index}`, objective: `Row ${String(index).padStart(2, '0')}` })),
  };
  const { app, selected } = mount(snapshot);
  const rows = (): string[] => app.lastFrame()!.split('\n').filter((row) => row.includes('Row '));
  app.stdin.write(kind === 'answer' ? 'o' : 'g');
  await vi.waitFor(() => expect(rows()).toHaveLength(10));
  for (let move = 0; move < 20; move++) app.stdin.write('\x1b[B');
  await vi.waitFor(() => {
    expect(rows()).toHaveLength(10);
    expect(rows()[0]).toContain('Row 02');
    expect(rows().at(-1)).toContain('Row 11');
  });
  app.stdin.write('\x1b[A');
  app.stdin.write('\x1b[A');
  await vi.waitFor(() => expect(app.lastFrame()).toMatch(/\x1b\[7m[^\n]*Row 09/u));
  expect(rows()[0]).toContain('Row 02');
  for (let move = 0; move < 20; move++) app.stdin.write('\x1b[A');
  await vi.waitFor(() => {
    expect(rows()).toHaveLength(10);
    expect(rows()[0]).toContain('Row 00');
    expect(rows().at(-1)).toContain('Row 09');
  });
  app.stdin.write('\r');
  if (kind === 'goal') {
    await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.goalActions.pause', 'en')));
    app.stdin.write('\r');
  }
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: kind === 'answer' ? 'answer' : 'pause',
    target: kind === 'answer' ? snapshot.questions[0] : snapshot.goals[0],
  })));
});

it.each([1, 10])('keeps all %i inquiry rows visible when they fit in the window', async (count) => {
  const snapshot = { goals, questions: Array.from({ length: count }, (_, index) => ({
    question: questions[0]!.question, repositoryDirectory: '/fixture', goalId: `goal-${index}`, objective: `Visible inquiry ${index}`,
  })) };
  const { app } = mount(snapshot);
  app.stdin.write('o');
  await vi.waitFor(() => {
    expect(app.lastFrame()!.split('\n').filter((row) => row.includes('Visible inquiry'))).toHaveLength(count);
    expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en'));
    expect(app.lastFrame()).toContain(getLabel('manager.selectionHint', 'en'));
  });
});
