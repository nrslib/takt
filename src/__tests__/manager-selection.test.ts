import { Box, Text, useInput } from 'ink';
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

afterEach(cleanup);

it('selects the second inquiry with consecutive arrow and Enter input', async () => {
  const { app, selected, opened } = mount();
  app.stdin.write('o');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en')));
  expect(opened).toHaveBeenCalledWith(true);
  app.stdin.write('\x1b[A');
  app.stdin.write('\x1b[B');
  app.stdin.write('\r');
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith({ kind: 'answer', target: questions[1] }));
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
