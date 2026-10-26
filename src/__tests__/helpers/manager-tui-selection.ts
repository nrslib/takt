import { expect, it } from 'vitest';
import type { SnapshotItem } from '../../features/manager/conversationPort.js';
import { getLabel } from '../../shared/i18n/index.js';
import { goalRecord } from './goal-fixtures.js';
import { ManagerClientDouble, cwd, mount, waitFor, promptFrame, ENTER, UP, DOWN, ESC, QUESTION_MENU, GOAL_MENU } from './manager-tui-fixtures.js';

const question = (index = 1): Extract<SnapshotItem, { kind: 'inquiry' }> => ({
  kind: 'inquiry', inquiry: { target: { goalId: goalRecord().id, repositoryDirectory: cwd }, objective: 'Answer goal',
    question: { id: '650e8400-e29b-41d4-a716-' + String(index).padStart(12, '0'),
      recipient: 'human', status: 'pending', body: 'Choose output ' + index, options: ['CSV', 'JSON'] } },
});
const goal = (executionStatus: 'active' | 'paused' = 'active'): Extract<SnapshotItem, { kind: 'goal' }> => ({
  kind: 'goal', goal: { id: goalRecord().id, objective: 'Control goal', status: 'created', executionStatus, repositoryDirectory: cwd },
});
function mounted(items: SnapshotItem[]) {
  const client = new ManagerClientDouble();
  client.change({ items: [...client.getSnapshot().items, ...items.filter((item) => item.kind !== 'state')] });
  return mount('en', client);
}
function expectCommandHint(context: ReturnType<typeof mount>, visible: boolean): void {
  const rows = context.app.lastFrame()!.split('\n');
  const promptEnd = rows.map((row) => row.startsWith('╰')).lastIndexOf(true);
  expect(promptEnd).toBeGreaterThan(0);
  const hints = rows.slice(promptEnd + 1).filter((row) => /^\s*\/make-goal\b/u.test(row));
  expect(hints).toHaveLength(visible ? 1 : 0);
}
async function chooseGoal(context: ReturnType<typeof mount>, action: 'pause' | 'resume' | 'abort') {
  await waitFor(() => expectCommandHint(context, true));
  context.app.stdin.write(GOAL_MENU);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.goal', 'en'));
    expectCommandHint(context, false);
  });
  context.app.stdin.write(ENTER);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.action', 'en'));
    expect(context.app.lastFrame()).toContain(getLabel('manager.goalActions.' + action, 'en'));
    expectCommandHint(context, false);
  });
  if (action === 'abort') context.app.stdin.write(DOWN);
  context.app.stdin.write(ENTER);
}
async function openAnswer(context: ReturnType<typeof mount>) {
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Pending 1');
    expectCommandHint(context, true);
  });
  context.app.stdin.write(QUESTION_MENU);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en'));
    expectCommandHint(context, false);
  });
  context.app.stdin.write(ENTER);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Free text');
    expect(promptFrame(context)).toContain('Enter your answer');
    expectCommandHint(context, false);
  });
}

it.each(['answer', 'goal'] as const)('hides command guidance in the %s list and restores it after Escape on the same screen', async (kind) => {
  const context = mounted([question(), goal()]);
  await waitFor(() => expectCommandHint(context, true));
  context.app.stdin.write(kind === 'answer' ? QUESTION_MENU : GOAL_MENU);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.' + kind, 'en'));
    expectCommandHint(context, false);
  });
  context.app.stdin.write(ESC);
  await waitFor(() => {
    expect(context.app.lastFrame()).not.toContain(getLabel('manager.selectionTitles.' + kind, 'en'));
    expectCommandHint(context, true);
  });
  expect(context.client.submit).not.toHaveBeenCalled();
});

it.each(['pause', 'resume'] as const)('sends %s for the selected goal through IPC and displays the operation result', async (action) => {
  const item = goal(action === 'pause' ? 'active' : 'paused');
  const context = mounted([item]);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Ongoing 1'));
  await chooseGoal(context, action);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: action === 'pause' ? 'pause_goal' : 'resume_goal', goalId: item.goal.id }]));
  context.client.output({ kind: 'result', operationId: await context.client.operation(), result: { kind: 'reply', message: 'Operation saved' } });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Operation saved');
    expect(context.app.lastFrame()).toContain(item.goal.objective);
  });
});

it.each([ENTER, ESC])('requires explicit abort confirmation and cancels it with %j without a mutation', async (cancel) => {
  const context = mounted([goal()]);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Ongoing 1'));
  await chooseGoal(context, 'abort');
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en'));
    expectCommandHint(context, false);
  });
  expect(context.client.submit).not.toHaveBeenCalled();
  context.app.stdin.write(cancel);
  await waitFor(() => {
    expect(context.app.lastFrame()).not.toContain(getLabel('manager.abortConfirmation', 'en'));
    expectCommandHint(context, true);
  });
  expect(context.client.submit).not.toHaveBeenCalled();
});

it('sends abort only after the human selects approval and preserves retry confirmation on an operation error', async () => {
  const item = goal();
  const context = mounted([item]);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Ongoing 1'));
  await chooseGoal(context, 'abort');
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.abortConfirmation', 'en')));
  context.app.stdin.write(UP);
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'abort_goal', goalId: item.goal.id }]));
  context.client.output({ kind: 'result', operationId: await context.client.operation(),
    result: { kind: 'error', code: 'operation_failed', message: 'Task invalidation failed' } });
  await waitFor(() => expect(context.app.lastFrame()).toContain('Task invalidation failed'));
  expect(context.app.lastFrame()).toMatch(/retry|再試行/iu);
  expectCommandHint(context, false);
});

it('sends the selected target and structured answer, then closes the saved answer on its completion event', async () => {
  const item = question();
  const context = mounted([item]);
  await openAnswer(context);
  context.app.stdin.write(DOWN);
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{
    kind: 'answer_question', target: item.inquiry.target, questionId: item.inquiry.question.id, answer: { text: 'JSON' },
  }]));
  context.client.output({ kind: 'result', operationId: await context.client.operation(),
    result: { kind: 'answer_saved', answerSaved: true, message: 'Answer saved' } });
  await waitFor(() => {
    expect(promptFrame(context)).toContain('Discuss your goal');
    expect(context.app.lastFrame()).toContain('Answer saved');
    expectCommandHint(context, true);
  });
});

it('sends /make-goal as a free-text inquiry answer without requesting a goal proposal', async () => {
  const item = question();
  const context = mounted([item]);
  await openAnswer(context);
  context.app.stdin.write('/make-goal');
  await waitFor(() => {
    expect(promptFrame(context)).toContain('/make-goal');
    expectCommandHint(context, false);
  });
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{
    kind: 'answer_question', target: item.inquiry.target, questionId: item.inquiry.question.id, answer: { text: '/make-goal' },
  }]));
  context.client.output({ kind: 'result', operationId: await context.client.operation(),
    result: { kind: 'answer_saved', answerSaved: true, message: 'Answer saved' } });
  await waitFor(() => {
    expect(promptFrame(context)).toContain('Discuss your goal');
    expect(context.app.lastFrame()).toContain('/make-goal');
    expectCommandHint(context, true);
  });
});

it.each([false, true])('shows partial success with permissionAppended and preserves only an unsaved answer (answerSaved=%s)', async (answerSaved) => {
  const item = question();
  const context = mounted([item]);
  await openAnswer(context);
  context.app.stdin.write('custom answer');
  await waitFor(() => expect(promptFrame(context)).toContain('custom answer'));
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toHaveLength(1));
  context.client.output({ kind: 'result', operationId: await context.client.operation(),
    result: { kind: 'error', code: 'operation_failed', message: 'Follow-up failed', permissionAppended: true, answerSaved } });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Follow-up failed');
    expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.permission_appended', 'en'));
    if (answerSaved) expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.answer_saved', 'en'));
    else expect(context.app.lastFrame()).not.toContain(getLabel('manager.conversation.answer_saved', 'en'));
    expect(promptFrame(context)).toContain(answerSaved ? 'Discuss your goal' : 'custom answer');
  });
  expect(context.client.commands()).toHaveLength(1);
});

it('keeps the standalone owner and does not substitute a goal target when sending an answer', async () => {
  const inquiry = question().inquiry;
  const owner = { kind: 'repository' as const, repositoryDirectory: cwd };
  const context = mounted([{ kind: 'inquiry', inquiry: { question: inquiry.question, target: { goalId: null, owner } } }]);
  await openAnswer(context);
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{
    kind: 'answer_question', target: { goalId: null, owner }, questionId: inquiry.question.id, answer: { text: 'CSV' },
  }]));
});

it('keeps the selected inquiry by identity when the first candidate is withdrawn on the same mounted screen', async () => {
  const first = question(1), second = question(2);
  const context = mounted([first, second]);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Pending 2'));
  context.app.stdin.write(QUESTION_MENU);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Choose output 2'));
  context.app.stdin.write(DOWN);
  const assignment = context.client.getSnapshot().items[0]!;
  context.client.change({ items: [assignment, second] });
  await waitFor(() => {
    expect(context.app.lastFrame()).not.toContain('Choose output 1');
    expect(context.app.lastFrame()).toContain('Choose output 2');
  });
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.app.lastFrame()).toContain('Free text'));
  context.app.stdin.write(ENTER);
  await waitFor(() => expect(context.client.commands()).toEqual([{
    kind: 'answer_question', target: second.inquiry.target, questionId: second.inquiry.question.id, answer: { text: 'CSV' },
  }]));
});

it('does not restore a withdrawn inquiry when Escape returns from details to its list', async () => {
  const context = mounted([question()]);
  await openAnswer(context);
  context.client.change({ items: [context.client.getSnapshot().items[0]!] });
  await waitFor(() => expect(context.app.lastFrame()).toContain('Pending 0'));
  context.app.stdin.write(ESC);
  await waitFor(() => expect(context.app.lastFrame()).not.toContain('Choose output'));
  expect(context.client.submit).not.toHaveBeenCalled();
});
