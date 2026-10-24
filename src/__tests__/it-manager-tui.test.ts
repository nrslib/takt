import { QUESTION_MENU, SUMMARY_MENU, selectionFrame, openMenu, chooseGoalAction, enterSelection, memory, failureNotice, cwd, summaryA, summaryB, ENTER, UP, response, mount, deferred, promptFrame, queuedFrame, waitFor, typeAndSubmit, send, approve } from './helpers/manager-tui-fixtures.js';
import './helpers/manager-tui-input.js';
import './helpers/manager-tui-startup.js';
import './helpers/manager-tui-selection.js';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import * as savedEvents from '../features/manager/savedEvents.js';
import * as workspaceRegistry from '../infra/config/global/workspaceRegistry.js';
import { formatGoalName } from '../features/manager/goalDisplay.js';
import { toDisplayText } from '../features/tui/displayText.js';
import type { Goal } from '../infra/goals/schema.js';
import { createGoal } from '../infra/goals/service.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const NOTICE_MENU = '\x0e';
const NOTICE_DOWN = '\x1b[B';
const NOTICE_ESCAPE = '\x1b[27u';
const noticeStartedAt = Date.parse('2026-10-24T00:00:00Z');
const noticeRecord = (index: number, overrides: Partial<NonNullable<Goal['notifications']>[number]> = {}) => ({
  id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, kind: 'completed' as const,
  body: `Private notice body ${index}`, recordedAt: new Date(noticeStartedAt - index - 1).toISOString(), ...overrides,
});
const noticeDialog = (context: ReturnType<typeof mount>): string | undefined => context.app.lastFrame()
  ?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu)?.find((box) => /Esc/u.test(box) && /↑|↓/u.test(box));
const noticeRows = (context: ReturnType<typeof mount>): string[] => noticeDialog(context)!.split('\n')
  .slice(2, -2).map((line) => stripVTControlCharacters(line).replace(/^│\s*|\s*│$/gu, ''));

describe('manager saved notice menu', () => {
  describe.each(['repository', 'workspace'] as const)('notices after adding a repository to a %s assignment', (kind) => {
    it.each([-1, 1])('uses the manager startup boundary for an added repository notice at offset %i', async (offset) => {
      vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
      const repositoryB = '/test/repository-b';
      const workspace = { id: '650e8400-e29b-41d4-a716-446655440001', name: 'A + B', repositoryDirectories: [cwd, repositoryB] };
      let savedWorkspace: workspaceRegistry.Workspace | undefined = kind === 'workspace'
        ? { ...workspace, repositoryDirectories: [cwd] } : undefined;
      vi.spyOn(workspaceRegistry, 'findWorkspaceForRepository').mockImplementation(async (_config, directory) =>
        savedWorkspace?.repositoryDirectories.includes(directory) ? savedWorkspace : undefined);
      vi.spyOn(workspaceRegistry, 'readWorkspace').mockImplementation(async (_config, id) =>
        savedWorkspace?.id === id ? savedWorkspace : undefined);
      const assignment = kind === 'repository'
        ? { kind, repositoryDirectory: cwd, repositoryDirectories: [cwd] }
        : { kind, workspaceId: workspace.id, name: workspace.name, repositoryDirectories: [cwd] };
      const goal: Goal = { ...goalRecord(), objective: 'Added goal', notifications: [noticeRecord(1, {
        body: 'Added repository notice', recordedAt: new Date(noticeStartedAt + offset).toISOString(),
      })] };
      const original = structuredClone(goal);
      memory.goals.mockImplementation((directory) => directory === repositoryB ? [goal] : []);
      const context = mount('en', undefined, assignment);
      try {
        await waitFor(() => {
          expect(context.app.lastFrame()).toContain('manager-repository');
          expect(context.app.lastFrame()).not.toContain('Working');
        });
        expect(await context.session.getAssignment()).toEqual(assignment);
        context.call.mockImplementationOnce(async (_prompt, options) => {
          options.onStream?.({ type: 'tool_use', data: { id: 'add-b', tool: 'takt_add_workspace_repository', input: { repositoryDirectory: repositoryB } } });
          savedWorkspace = workspace;
          options.onStream?.({ type: 'tool_result', data: { id: 'add-b', isError: false, content: JSON.stringify({ workspace }) } });
          return response(null);
        });
        await typeAndSubmit(context, 'Add repository B');
        await waitFor(() => {
          expect(context.app.lastFrame()!.split('\n')).toContain(getLabel('manager.assignmentHeadingMultiple', 'en', {
            name: 'manager-repository', count: '1',
          }));
          expect(context.app.lastFrame()).not.toContain('Working');
        });
        const heading = getLabel('manager.notificationHeadings.completed', 'en', { project: 'repository-b' });
        const notificationRows = context.app.lastFrame()!.split('\n').filter((line) =>
          line.includes(heading) || line.includes(goal.objective) || line.includes(goal.notifications![0]!.body));
        if (offset < 0) expect(notificationRows).toEqual([]);
        else {
          expect(notificationRows).toHaveLength(3);
          expect(notificationRows[0]).toContain(heading);
          expect(notificationRows[1]).toContain(goal.objective);
          expect(notificationRows[2]).toContain(goal.notifications![0]!.body);
        }
        context.app.stdin.write(NOTICE_MENU);
        await waitFor(() => expect(noticeDialog(context)).toContain(goal.objective));
        expect(noticeRows(context)).toHaveLength(1);
        context.app.stdin.write(ENTER);
        await waitFor(() => expect(noticeDialog(context)).toContain(goal.notifications![0]!.body));
        expect(goal).toEqual(original);
      } finally { context.app.unmount(); await context.session.close(); }
    });
  });

  it.each([0, 1])('retains the answer draft for an empty notice list and opens a nonempty list with %i notices', async (count) => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Inquiry and notice',
      notifications: count === 0 ? [] : [noticeRecord(1)], questions: [{
        id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: 'Choose CSV or JSON',
      }] }]);
    const context = mount();
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    const answer = vi.spyOn(context.session, 'answerQuestion');
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      context.app.stdin.write('CSVで出力する');
      await waitFor(() => expect(promptFrame(context)).toContain('CSVで出力する'));
      const beforeFrame = context.app.lastFrame();
      const beforeRead = read.mock.calls.length;
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(beforeRead));
      await read.mock.results.at(-1)!.value;
      if (count === 0) {
        const completed = read.mock.calls.length;
        await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(completed));
        await waitFor(() => expect(context.app.lastFrame()).toBe(beforeFrame));
        expect(promptFrame(context)).toContain('CSVで出力する');
        expect(selectionFrame(context)).toBeUndefined();
      } else {
        await waitFor(() => expect(noticeDialog(context)).toContain(getLabel('manager.selectionTitles.notice', 'en')));
        expect(noticeRows(context)).toHaveLength(1);
        expect(noticeRows(context)[0]).toContain('Inquiry and notice');
      }
      expect(answer).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([true, false])('handles a delayed notice read from the answer screen with Esc cancellation=%s', async (cancel) => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Inquiry and notice', notifications: [noticeRecord(1)], questions: [{
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: 'Choose CSV or JSON',
    }] }]);
    const context = mount();
    const refresh = deferred<Awaited<ReturnType<typeof context.session.getAssignment>>>();
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    const answer = vi.spyOn(context.session, 'answerQuestion');
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      context.app.stdin.write('CSVで出力する');
      await waitFor(() => expect(promptFrame(context)).toContain('CSVで出力する'));
      const assignment = vi.spyOn(context.session, 'getAssignment').mockReturnValue(refresh.promise);
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(assignment).toHaveBeenCalled());
      if (cancel) {
        context.app.stdin.write(NOTICE_ESCAPE);
        await waitFor(() => expect(selectionFrame(context)).toContain(getLabel('manager.selectionTitles.answer', 'en')));
      }
      const beforeRead = read.mock.calls.length;
      refresh.resolve(undefined);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(beforeRead));
      await read.mock.results.at(-1)!.value;
      if (cancel) {
        const completed = read.mock.calls.length;
        await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(completed));
        expect(selectionFrame(context)).toContain(getLabel('manager.selectionTitles.answer', 'en'));
        expect(noticeRows(context)).toHaveLength(1);
        expect(noticeRows(context)[0]).toContain('Choose CSV or JSON');
      } else {
        await waitFor(() => expect(noticeDialog(context)).toContain(getLabel('manager.selectionTitles.notice', 'en')));
        expect(noticeRows(context)).toHaveLength(1);
        expect(noticeRows(context)[0]).toContain('Inquiry and notice');
      }
      expect(answer).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); refresh.resolve(undefined); await context.session.close(); }
  });

  it('hides startup history but retains it for Ctrl+N and displays a later completion on the same screen', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const goal: Goal = { ...goalRecord(), status: 'completed', objective: 'Historical completion',
      completion: {
        goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
        summary: 'Historical completion summary', instructions: [],
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      },
      notifications: [noticeRecord(1, { kind: 'awaiting_merge' }), noticeRecord(2)], questions: [{
        id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: 'Pending inquiry',
      }] };
    memory.goals.mockReturnValue([goal]);
    const context = mount('ja');
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    const headings = ['awaiting_merge', 'completed'] as const;
    try {
      await waitFor(() => {
        expect(context.app.lastFrame()).toContain('進行中 0');
        expect(context.app.lastFrame()).toContain('未回答 1');
        expect(context.app.lastFrame()).not.toContain('処理中');
      });
      for (const kind of headings) expect(context.app.lastFrame()!.split('\n').filter((line) =>
        line.includes(getLabel(`manager.notificationHeadings.${kind}`, 'ja', { project: 'manager-repository' })))).toEqual([]);
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toBeDefined());
      expect(noticeRows(context)).toHaveLength(2);
      context.app.stdin.write(NOTICE_ESCAPE);
      await waitFor(() => expect(noticeDialog(context)).toBeUndefined());
      const updated: Goal = { ...goal, notifications: [...goal.notifications!, noticeRecord(3, {
        body: 'New completion after startup', recordedAt: new Date(noticeStartedAt + 1).toISOString(),
      })] };
      memory.goals.mockReturnValue([updated]);
      await waitFor(() => {
        const frame = context.app.lastFrame()!;
        expect(frame).toContain('New completion after startup');
        expect(frame).toContain(getLabel('manager.notificationHeadings.completed', 'ja', { project: 'manager-repository' }));
        expect(frame).toContain(`ゴール: ${goal.objective}`);
      });
      const polls = read.mock.calls.length;
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));
      expect(context.app.lastFrame()!.split('\n').filter((line) => line.includes('New completion after startup'))).toHaveLength(1);
      for (const old of goal.notifications!) expect(context.app.lastFrame()).not.toContain(old.body);
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toBeDefined());
      expect(noticeRows(context)).toHaveLength(3);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(noticeDialog(context)).toContain('New completion after startup'));
      expect(updated.notifications!.slice(0, 2)).toEqual(goal.notifications);
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('displays three summary lines from a new 7000-character merge notice and the complete merge command', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const context = mount('ja');
    const command = "git -C '/Users/nrs/work/git/takt3' merge --no-ff --no-edit b89dc7274403152da8933cda80a76a4751c7901d";
    const summary = ['First summary', 'Second summary', 'Third summary', 'Hidden summary ' + 'x'.repeat(6942)].join('\n');
    expect(summary).toHaveLength(7000);
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('処理中'));
      const goal: Goal = { ...goalRecord(), objective: 'Merge digest fixture', completion: {
        goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary,
        worktrees: ['/Users/nrs/work/git/takt3'], instructions: [command],
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      }, notifications: [noticeRecord(1, { kind: 'awaiting_merge', body: 'Unused merge body', recordedAt: new Date(noticeStartedAt + 1).toISOString() })] };
      memory.goals.mockReturnValue([goal]);
      await waitFor(() => expect(context.app.lastFrame()).toContain('First summary'));
      const frame = context.app.lastFrame()!;
      expect(frame).toContain(getLabel('manager.notificationHeadings.awaiting_merge', 'ja', { project: 'manager-repository' }));
      expect(frame).toContain(`ゴール: ${goal.objective}`);
      for (const line of summary.split('\n').slice(0, 3)) expect(frame).toContain(line);
      const bodyRows = frame.split('\n').filter((line) => /summary/u.test(line));
      expect(bodyRows.map((line) => line.replace(/^\s*│?\s*/u, '').trimEnd())).toEqual(summary.split('\n').slice(0, 3));
      expect(frame.split('\n').filter((line) => /Ctrl\+N|\^N/u.test(line) && /全文/u.test(line))).toHaveLength(1);
      const normalized = frame.split('\n').map((line) => line.replace(/^\s*│?\s*|\s*│?\s*$/gu, '')).join('');
      expect(normalized).toContain(command);
      expect(normalized).not.toContain(command + '…');
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('opens ten heading-and-goal rows and selects the eleventh after ten down arrows', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const goals: Goal[] = Array.from({ length: 12 }, (_, index) => ({ ...goalRecord(),
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
      objective: `Notice ${String(index + 1).padStart(2, '0')} ` + 'long objective '.repeat(8), notifications: [noticeRecord(index)],
    }));
    memory.goals.mockReturnValue(goals);
    const context = mount();
    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toBeDefined());
      const heading = getLabel('manager.notificationHeadings.completed', 'en', { project: 'manager-repository' });
      expect(noticeRows(context)).toHaveLength(10);
      for (const [index, goal] of goals.slice(0, 10).entries()) {
        const row = noticeRows(context)[index]!;
        expect(row).toContain(heading);
        expect(row).toContain(formatGoalName(goal.objective));
        expect(row.replace(heading, '').replace(formatGoalName(goal.objective), '')).toMatch(/^[\p{P}\p{S}\s]*$/u);
      }
      for (const goal of goals) expect(noticeDialog(context)).not.toContain(goal.notifications![0]!.body);
      for (let move = 0; move < 10; move++) context.app.stdin.write(NOTICE_DOWN);
      await waitFor(() => {
        expect(noticeRows(context)).toHaveLength(10);
        expect(noticeRows(context).some((row) => row.includes('Notice 11'))).toBe(true);
        expect(noticeRows(context).some((row) => row.includes('Notice 01'))).toBe(false);
        expect(noticeDialog(context)).toMatch(/\x1b\[7m[^\n]*Notice 11/u);
      });
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(noticeDialog(context)).toContain('Private notice body 10'));
      context.app.stdin.write(NOTICE_ESCAPE);
      await waitFor(() => {
        expect(noticeRows(context)).toHaveLength(10);
        expect(noticeDialog(context)).toMatch(/\x1b\[7m[^\n]*Notice 11/u);
      });
      context.app.stdin.write(NOTICE_ESCAPE);
      await waitFor(() => expect(noticeDialog(context)).toBeUndefined());
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); chalk.level = previousLevel; await context.session.close(); }
  });

  it.each([false, true])('reads all 7000 body characters by scrolling and returns to the list during a turn=%s', async (busy) => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const lines = Array.from({ length: 100 }, (_, index) => `Body ${String(index).padStart(3, '0')}: ` + 'x'.repeat(59));
    lines[99] += 'Z';
    const body = lines.join('\n');
    expect(body).toHaveLength(7000);
    memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Full notice', notifications: [noticeRecord(1, { body })] }]);
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion');
    if (busy) context.call.mockReturnValueOnce(turn.promise);
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      if (busy) {
        await typeAndSubmit(context, 'Continue the current work');
        await waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      }
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toContain('Full notice'));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(noticeDialog(context)).toContain(lines[0]!));
      const observed = new Set<string>();
      const collect = (): void => {
        const rows = noticeDialog(context)!.split('\n').slice(1, -1)
          .map((line) => stripVTControlCharacters(line).replace(/^│\s*|\s*│$/gu, ''))
          .filter((row) => row.startsWith('Body '));
        for (const row of rows) observed.add(row);
        expect(noticeDialog(context)).not.toContain('…');
      };
      collect();
      for (let move = 0; move < 110 && !observed.has(lines[99]!); move++) {
        const before = noticeDialog(context);
        context.app.stdin.write(NOTICE_DOWN);
        await waitFor(() => expect(noticeDialog(context)).not.toBe(before));
        collect();
      }
      expect([...observed]).toEqual(lines);
      for (let move = 0; move < 110; move++) context.app.stdin.write(UP);
      await waitFor(() => expect(noticeDialog(context)).toContain(lines[0]!));
      context.app.stdin.write(NOTICE_ESCAPE);
      await waitFor(() => {
        expect(noticeDialog(context)).toContain('Full notice');
        expect(noticeDialog(context)).not.toContain('Body 000:');
      });
      context.app.stdin.write(NOTICE_ESCAPE);
      await waitFor(() => expect(noticeDialog(context)).toBeUndefined());
      if (busy) expect(context.call.mock.calls[0]![1].abortSignal!.aborted).toBe(false);
      expect(answer).not.toHaveBeenCalled();
      expect(context.call).toHaveBeenCalledTimes(busy ? 1 : 0);
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('leaves the normal screen unchanged when Ctrl+N refreshes an empty notice list', async () => {
    const context = mount();
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write('Unsent draft');
      await waitFor(() => expect(promptFrame(context)).toContain('Unsent draft'));
      const frame = context.app.lastFrame();
      const before = read.mock.calls.length;
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(noticeDialog(context)).toBeUndefined();
      expect(context.app.lastFrame()).toBe(frame);
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('refreshes saved notices before opening Ctrl+N on the same screen', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const context = mount();
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Saved after initial read', notifications: [noticeRecord(1)] }]);
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toContain('Saved after initial read'));
      expect(noticeRows(context)).toHaveLength(1);
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('wraps a single-line notice at the terminal width and scrolls to its end', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    const body = '本文開始' + 'あ'.repeat(7000) + '本文終了';
    memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Wrapped notice', notifications: [noticeRecord(1, { body })] }]);
    const context = mount();
    vi.spyOn(context.app.stdout, 'columns', 'get').mockReturnValue(40);
    context.app.stdout.emit('resize');
    try {
      await waitFor(() => expect(context.app.lastFrame()).not.toContain('Working'));
      context.app.stdin.write(NOTICE_MENU);
      await waitFor(() => expect(noticeDialog(context)).toContain(getLabel('manager.selectionTitles.notice', 'en')));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(noticeDialog(context)).toContain('本文開始'));
      expect(noticeDialog(context)).not.toContain('本文終了');
      for (let move = 0; move < 400; move++) context.app.stdin.write(NOTICE_DOWN);
      await waitFor(() => expect(noticeDialog(context)).toContain('本文終了'));
      expect(noticeDialog(context)).not.toContain('本文開始');
      expect(noticeDialog(context)).not.toContain('…');
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('keeps Ctrl+R on inquiries when a saved notice is also present', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(noticeStartedAt);
    memory.goals.mockReturnValue([{ ...goalRecord(), objective: 'Inquiry and notice', notifications: [noticeRecord(1)], questions: [{
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: 'Choose CSV or JSON',
    }] }]);
    const context = mount();
    try {
      await openMenu(context, 'answer');
      await waitFor(() => expect(selectionFrame(context)).toContain(getLabel('manager.selectionTitles.answer', 'en')));
      expect(noticeRows(context)).toHaveLength(1);
      expect(noticeRows(context)[0]).toContain('Choose CSV or JSON');
      expect(noticeDialog(context)).not.toContain('Private notice body');
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each(['ja', 'en'] as const)('shows all menu keys below the input instead of on the counts line in %s', async (lang) => {
    const context = mount(lang);
    try {
      await waitFor(() => {
        const frame = context.app.lastFrame()!;
        const rows = frame.split('\n');
        expect(rows[1]).not.toMatch(/\^|Enter|Esc|Ctrl/u);
        const hint = rows.slice(rows.map((line) => line.startsWith('╰')).lastIndexOf(true) + 1).join(' ');
        expect(hint).toMatch(lang === 'ja' ? /\^R 問い合わせ.*\^G ゴール.*\^O 要約.*\^N 知らせ.*\^P 担当.*\^C 終了/u
          : /\^R.*(?:inquir|question).*\^G.*goal.*\^O.*summary.*\^N.*(?:notice|notification).*\^P.*\^C/iu);
      });
    } finally { context.app.unmount(); await context.session.close(); }
  });
});

describe('manager inquiry windows and detail navigation', () => {
  it('shows ten inquiries and opens the eleventh after ten down arrows in the same screen', async () => {
    const questions = Array.from({ length: 12 }, (_, index) => ({
      goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Window fixture', question: {
        id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
        recipient: 'human' as const, status: 'pending' as const,
        body: `Inquiry ${String(index + 1).padStart(2, '0')}\nDetail ${String(index + 1).padStart(2, '0')}`,
      },
    }));
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion');
    const rows = (): string[] => selectionFrame(context)!.split('\n').filter((row) => row.includes('Window fixture'));
    try {
      await openMenu(context, 'answer');
      await vi.waitFor(() => expect(selectionFrame(context)).toBeDefined());
      expect(rows()).toHaveLength(10);
      for (let index = 1; index <= 10; index++) expect(rows()[index - 1]).toContain(`Inquiry ${String(index).padStart(2, '0')}`);
      for (let move = 0; move < 10; move++) context.app.stdin.write('\x1b[B');
      await vi.waitFor(() => {
        expect(rows()).toHaveLength(10);
        expect(rows().some((row) => row.includes('Inquiry 11'))).toBe(true);
        expect(rows().some((row) => row.includes('Inquiry 01'))).toBe(false);
      });
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(context.app.lastFrame()).toContain('Detail 11');
        expect(promptFrame(context)).toContain('Enter your answer');
        expect(selectionFrame(context)).toBeUndefined();
      });
      context.app.stdin.write('\x1b[27u');
      await vi.waitFor(() => {
        expect(selectionFrame(context)).toBeDefined();
        expect(rows()).toHaveLength(10);
        expect(rows().some((row) => row.includes('Inquiry 11'))).toBe(true);
        expect(rows().some((row) => row.includes('Inquiry 01'))).toBe(false);
      });
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(context.app.lastFrame()).toContain('Detail 11'));
      expect(answer).not.toHaveBeenCalled();
      expect(context.call).not.toHaveBeenCalled();
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it.each([false, true])('scrolls detail text and returns to the selected inquiry without saving during a turn=%s', async (busy) => {
    const lines = Array.from({ length: 30 }, (_, index) => `Body line ${String(index + 1).padStart(2, '0')}`);
    const questions = [0, 1].map((index) => ({
      goalId: goalRecord().id, repositoryDirectory: cwd, objective: `Detail fixture ${index}`, question: {
        id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
        recipient: 'human' as const, status: 'pending' as const, body: index === 0 ? 'Other inquiry' : lines.join('\n'),
      },
    }));
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions });
    const turn = deferred<ReturnType<typeof response>>();
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion');
    if (busy) context.call.mockReturnValueOnce(turn.promise);
    const detail = (): string => context.app.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu)!
      .find((box) => box.includes(getLabel('manager.answerPrompt', 'en')))!;
    try {
      if (busy) {
        await typeAndSubmit(context, 'Continue working');
        await vi.waitFor(() => expect(context.call).toHaveBeenCalledOnce());
      }
      await openMenu(context, 'answer');
      await vi.waitFor(() => expect(selectionFrame(context)).toBeDefined());
      context.app.stdin.write('\x1b[B');
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(detail()).toContain(lines[0]!));
      const initial = detail();
      const visible = lines.filter((line) => initial.includes(line));
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(lines.length);
      context.app.stdin.write('\x1b[B');
      await vi.waitFor(() => {
        expect(detail()).toContain(lines[visible.length]!);
        expect(detail()).not.toContain(lines[0]!);
      });
      context.app.stdin.write('\x1b[27u');
      await vi.waitFor(() => {
        expect(selectionFrame(context)).toContain('Detail fixture 0');
        expect(selectionFrame(context)).toContain('Detail fixture 1');
        expect(promptFrame(context)).toContain('Discuss your goal');
      });
      if (busy) expect(context.call.mock.calls[0]![1].abortSignal!.aborted).toBe(false);
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(detail()).toContain(lines[0]!));
      expect(detail()).not.toContain(lines.at(-1)!);
      expect(answer).not.toHaveBeenCalled();
      expect(context.call).toHaveBeenCalledTimes(busy ? 1 : 0);
    } finally { context.app.unmount(); turn.resolve(response(null)); await context.session.close(); }
  });

  it('keeps cursor movement ahead of body scrolling when a free-text answer contains text', async () => {
    const target = { goalId: goalRecord().id, repositoryDirectory: cwd, objective: 'Cursor fixture', question: {
      id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const, status: 'pending' as const,
      body: Array.from({ length: 30 }, (_, index) => `Cursor body ${index}`).join('\n'),
    } };
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
    const context = mount();
    const answer = vi.spyOn(context.session, 'answerQuestion').mockResolvedValue({ kind: 'reply', message: 'Answer saved', answerSaved: true });
    try {
      await openMenu(context, 'answer');
      await enterSelection(context);
      await vi.waitFor(() => expect(promptFrame(context)).toContain('Enter your answer'));
      context.app.stdin.write('\x1b[200~first\nsecond\x1b[201~');
      await vi.waitFor(() => expect(promptFrame(context)).toContain('second'));
      context.app.stdin.write(UP);
      context.app.stdin.write('!');
      context.app.stdin.write(ENTER);
      await vi.waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        questionId: target.question.id, answer: { text: 'first!\nsecond' },
      })));
    } finally { context.app.unmount(); await context.session.close(); }
  });
});

describe('manager TUI summary menu and conversation input', () => {
  it.each(['request', 'register'] as const)('keeps a queued summary %s on menu Esc and discards it on ordinary Esc', async (operation) => {
    for (const closeMenu of [false, true]) {
      const empty = { events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [] };
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
    const snapshot = { events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] };
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
    vi.spyOn(savedEvents, 'readManagerDisplayEvents').mockResolvedValue({ events: [], diagnostics: [], notices: [], goals: [goalRecord()], questions: [target] });
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
    const emptySnapshot = { events: [], diagnostics: [], notices: [], questions: [], goals: [] };
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
    await waitFor(() => expect(app.lastFrame()).toContain('manager-repository'));
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
      expect(app.lastFrame()!.split('\n')[0]).toMatch(/manager-repository/u);
      expect(app.lastFrame()).toMatch(/experimental/iu);
    });
    expect(call).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps Ctrl+A, Ctrl+E and Ctrl+K editing the conversation draft', async () => {
    const context = mount('ja');
    context.call.mockResolvedValue(response(null));
    try {
      context.app.stdin.write('あいう');
      await waitFor(() => expect(promptFrame(context)).toContain('あいう'));
      context.app.stdin.write('\x01');
      context.app.stdin.write('前');
      await waitFor(() => expect(promptFrame(context)).toContain('前あいう'));
      context.app.stdin.write('\x05');
      context.app.stdin.write('後');
      await waitFor(() => expect(promptFrame(context)).toContain('前あいう後'));
      context.app.stdin.write('\x01');
      context.app.stdin.write('\x1b[C');
      context.app.stdin.write('\x0b');
      await waitFor(() => {
        expect(promptFrame(context)).toContain('前');
        expect(promptFrame(context)).not.toContain('あいう後');
      });
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.call).toHaveBeenCalledExactlyOnceWith('前', expect.any(Object)));
    } finally { context.app.unmount(); await context.session.close(); }
  });

  it('continues conversation on the default confirmation choice without registering', async () => {
    const context = mount();
    const { app, register } = context;
    await waitFor(() => expect(app.lastFrame()).toContain('manager-repository'));
    await send(context, 'CSV出力を追加したい', summaryA);

    app.stdin.write(ENTER);
    await waitFor(() => expect(context.session.getPendingSummary()).toBeNull());
    await send(context, '範囲外の内容を確認してください', summaryA);

    expect(register).not.toHaveBeenCalled();
  });

  it('approves the revised displayed summary only through the confirmation keys in the same mounted screen', async () => {
    const context = mount();
    const { app, call } = context;
    await waitFor(() => expect(app.lastFrame()).toContain('manager-repository'));
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
          await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));

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
          await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));

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
        await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));

        await send(context, '要約を確認してください', summary);

        expect(context.app.lastFrame()).not.toContain('[]');
        await approve(context, summary);
      });
    });

    it('sanitizes each displayed bullet independently', async () => {
      const context = mount(lang);
      const summary = { ...summaryA, outOfScope: ['CSV\x1b[', '通知'], acceptanceCriteria: ['\x1b[31mCSVを取得できる\x1b[0m'] };
      vi.spyOn(context.session, 'getPendingSummary').mockReturnValue({ revision: 1, summary });
      await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));
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
