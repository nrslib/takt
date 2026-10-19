import { Box, Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagerSelectionDialog } from '../features/manager/ManagerSelectionDialog.js';
import { useManagerSelection, type ManagerSelectionCommand, type ManagerSelectedTarget } from '../features/manager/useManagerSelection.js';
import type { ManagerDisplayGoal } from '../features/manager/savedEvents.js';
import type { PendingQuestion } from '../features/manager/useManagerQuestionAnswer.js';
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
  goalId: `goal-${index}`, objective: `Inquiry goal ${index}`, question: {
    id: 'shared-question-id', recipient: 'human', status: 'pending', body: `Inquiry ${index}`,
  },
}));

function mount(kind: ManagerSelectionCommand, snapshot = { goals, questions }, lang: 'en' | 'ja' = 'en') {
  const selected = vi.fn<(target: ManagerSelectedTarget) => void>();
  const opened = vi.fn<(result: boolean) => void>();
  function Probe() {
    const selection = useManagerSelection();
    useInput((input, key) => {
      if (input === 'o') opened(selection.open(kind, snapshot));
      else selection.handleInput(key, selected);
    });
    return createElement(Box, { flexDirection: 'column', width: 120 },
      createElement(Text, {}, 'Selection probe'),
      selection.selection === null ? null : createElement(ManagerSelectionDialog, { selection: selection.selection, lang }));
  }
  return { app: render(createElement(Probe)), selected, opened };
}

afterEach(cleanup);

it.each(['answer', 'pause', 'resume', 'abort'] as const)('selects the second %s candidate with consecutive arrow and Enter input', async (kind) => {
  const { app, selected, opened } = mount(kind);
  app.stdin.write('o');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel(`manager.selectionTitles.${kind}`, 'en')));
  expect(opened).toHaveBeenCalledWith(true);
  if (kind !== 'answer') {
    expect(app.lastFrame()).not.toContain('Completed');
    expect(app.lastFrame()).not.toContain('Aborted');
  }
  app.stdin.write('\x1b[A');
  app.stdin.write('\x1b[B');
  app.stdin.write('\r');
  const target = kind === 'answer' ? questions[1] : goals[kind === 'resume' ? 3 : 1];
  await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith({ kind, target }));
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en')));
});

it.each(['ja', 'en'] as const)('renders a single row per inquiry with shared controls in %s and closes on Esc', async (lang) => {
  const { app, selected } = mount('answer', { goals, questions }, lang);
  app.stdin.write('o');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.selectionHint', lang)));
  expect(app.lastFrame()!.split('\n').filter((line) => line.includes('Inquiry goal'))).toHaveLength(2);
  app.stdin.write('\x1b[27u');
  await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Inquiry goal'));
  expect(selected).not.toHaveBeenCalled();
});

it.each(['answer', 'pause', 'resume', 'abort'] as const)('does not open an empty %s selection', async (kind) => {
  const { app, opened, selected } = mount(kind, { goals: goals.slice(4), questions: [] });
  app.stdin.write('o');
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(false));
  expect(app.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en'));
  expect(selected).not.toHaveBeenCalled();
});
