import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptView } from '../features/tui/TranscriptEntryView.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { cwd, DOWN, ENTER, ManagerClientDouble, mount, promptFrame, QUESTION_MENU, waitFor } from './helpers/manager-tui-fixtures.js';

vi.mock('../features/tui/TranscriptEntryView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/TranscriptEntryView.js')>();
  return { ...actual, TranscriptView: vi.fn((props: Parameters<typeof actual.TranscriptView>[0]) =>
    createElement(actual.TranscriptView, props)) };
});

const entries = () => vi.mocked(TranscriptView).mock.calls.at(-1)![0].entries;

describe.each(['ja', 'en'] as const)('manager view (%s)', (lang) => {
  it('shows assignment, counts and experimental status on one bottom row after the key hints', async () => {
    const client = new ManagerClientDouble();
    const assignment = client.getSnapshot().items[0]!;
    client.change({ items: [assignment, { kind: 'goal', goal: { ...goalRecord(), repositoryDirectory: cwd } }, {
      kind: 'inquiry', inquiry: { question: createInquiry({ body: 'Pending question' }),
        target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } },
    }] });
    const context = mount(lang, client);
    Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: 120 });
    context.app.stdout.emit('resize');
    const heading = getLabel('manager.assignmentHeading', lang, { name: 'manager-repository' });
    const counts = getLabel('manager.counts', lang, { goals: '1', questions: '1' });
    const status = [heading, counts, getLabel('manager.statusExperimental', lang)].join(' | ');
    await waitFor(() => {
      const rows = context.app.lastFrame()!.split('\n');
      expect(rows.slice(-2)).toEqual([getLabel('manager.inputHint', lang), status]);
      expect(rows.filter((row) => row.includes(heading) || row.includes(counts))).toEqual([status]);
      expect(rows.join('\n')).not.toContain('/make-goal');
      expect(rows.join('').replace(/\s+/gu, '')).not.toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
    });
    expect(client.submit).not.toHaveBeenCalled();
    context.app.stdin.write('/');
    await waitFor(() => expect(context.app.lastFrame()).toContain(`/make-goal  ${getLabel('manager.makeGoalDescription', lang)}`));
  });

  it('preserves the multiple repository heading on the bottom status row', async () => {
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Workspace',
      repositoryDirectories: [cwd, '/test/second', '/test/third'],
    } }] });
    const { app } = mount(lang, client);
    await waitFor(() => expect(app.lastFrame()!.split('\n').at(-1)).toBe([
      getLabel('manager.assignmentHeadingMultiple', lang, { name: 'manager-repository', count: '2' }),
      getLabel('manager.counts', lang, { goals: '0', questions: '0' }),
      getLabel('manager.statusExperimental', lang),
    ].join(' | ')));
  });

  it('shows an empty assignment on the bottom status row', async () => {
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Empty workspace',
      repositoryDirectories: [],
    } }] });
    const { app } = mount(lang, client);
    await waitFor(() => expect(app.lastFrame()!.split('\n').at(-1)).toBe([
      getLabel('manager.selectionEmpty.repository', lang),
      getLabel('manager.counts', lang, { goals: '0', questions: '0' }),
      getLabel('manager.statusExperimental', lang),
    ].join(' | ')));
    expect(app.lastFrame()).not.toContain('manager-repository');
  });

  it.each([40, 42])('preserves the status suffix with a truncated ordinary assignment heading within %i columns', async (columns) => {
    const { app } = mount(lang);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const status = rows.at(-1)!;
      const [heading] = status.split(' | ');
      const counts = getLabel('manager.counts', lang, { goals: '0', questions: '0' });
      expect(heading).toContain('…');
      expect(status.split(' | ')).toEqual([heading, counts, getLabel('manager.statusExperimental', lang)]);
      expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
      for (const row of rows) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it.each([40, 80])('truncates only the assignment heading and preserves counts and experimental status within %i columns', async (columns) => {
    const name = '開発repository'.repeat(30);
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory: `/test/${name}`, repositoryDirectories: [`/test/${name}`],
    } }] });
    const { app } = mount(lang, client);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const status = rows.at(-1)!;
      const [heading, counts, experimental] = status.split(' | ');
      expect(heading).toContain('…');
      expect(counts).toBe(getLabel('manager.counts', lang, { goals: '0', questions: '0' }));
      expect(experimental).toBe(getLabel('manager.statusExperimental', lang));
      expect(rows.filter((row) => row.includes(counts!))).toEqual([status]);
      for (const row of rows) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it('preserves both ends of a long workspace assignment heading and nonzero counts when resized', async () => {
    const name = `開発-${'👩‍💻e\u0301作業'.repeat(20)}-末尾`;
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001', name: 'Workspace',
      repositoryDirectories: [repositoryDirectory, '/test/second', '/test/third'],
    } }, ...Array.from({ length: 12 }, () => ({ kind: 'goal' as const, goal: { ...goalRecord(), id: randomUUID(), repositoryDirectory } })),
    ...Array.from({ length: 3 }, () => ({ kind: 'inquiry' as const, inquiry: {
      question: createInquiry({ body: 'Pending question' }),
      target: { goalId: null, owner: { kind: 'repository' as const, repositoryDirectory } },
    } }))] });
    const { app } = mount(lang, client);
    const fullHeading = getLabel('manager.assignmentHeadingMultiple', lang, { name, count: '2' });
    const counts = getLabel('manager.counts', lang, { goals: '12', questions: '3' });
    const experimental = getLabel('manager.statusExperimental', lang);
    for (const columns of [80, 60, 120]) {
      Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
      app.stdout.emit('resize');
      await waitFor(() => {
        const rows = app.lastFrame()!.split('\n');
        const status = rows.at(-1)!;
        const [heading] = status.split(' | ');
        expect(status.split(' | ')).toEqual([heading, counts, experimental]);
        const [start, end] = heading!.trimEnd().split('…');
        expect(start!.length).toBeGreaterThan(0);
        expect(end!.length).toBeGreaterThan(0);
        expect(fullHeading.startsWith(start!)).toBe(true);
        expect(fullHeading.slice(-end!.length)).toBe(end);
        expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
        for (const row of rows) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
      });
    }
  });

  it.each([undefined, ['CSV', 'JSON']])('keeps ordinary question answers as the input or selected option (%j)', async (options) => {
    const client = new ManagerClientDouble();
    const question = createInquiry({ body: 'Choose output', ...(options === undefined ? {} : { options }) });
    const target = { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } as const;
    client.change({ items: [client.getSnapshot().items[0]!, { kind: 'inquiry', inquiry: { target, question } }] });
    const context = mount(lang, client);
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.counts', lang, { goals: '0', questions: '1' })));
    context.app.stdin.write(QUESTION_MENU);
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', lang)));
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.app.lastFrame()).toContain(question.body));
    const text = options === undefined ? 'Use plain text' : options[0]!;
    if (options === undefined) {
      context.app.stdin.write(text);
      await waitFor(() => expect(promptFrame(context)).toContain(text));
    }
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'answer_question', target, questionId: question.id, answer: { text } }]));
    const operationId = await client.operation();
    client.output({ kind: 'result', operationId, result: { kind: 'answer_saved', message: 'Answer stored', answerSaved: true } });
    await waitFor(() => expect(entries().filter((entry) => entry.role === 'user')).toEqual([{ role: 'user', content: text }]));
  });

  describe.each(['completed', 'unable'] as const)('operation request answer: %s', (report) => {
    it.each(['', ' \t\n ', 'Checked the output\nNo errors'])('shows the selected answer with comment %j without an empty user entry', async (comment) => {
      const client = new ManagerClientDouble();
      const question = createInquiry({ kind: 'operation_request', body: 'Confirm output' });
      const target = { goalId: null, owner: { kind: 'repository', repositoryDirectory: cwd } } as const;
      client.change({ items: [client.getSnapshot().items[0]!, { kind: 'inquiry', inquiry: { target, question } }] });
      const context = mount(lang, client);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.counts', lang, { goals: '0', questions: '1' })));
      context.app.stdin.write(QUESTION_MENU);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', lang)));
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.answerStages.report', lang)));
      if (report === 'unable') context.app.stdin.write(DOWN);
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.answerStages.comment', lang)));
      if (comment !== '') {
        context.app.stdin.write('\x1b[200~' + comment + '\x1b[201~');
        await waitFor(() => expect(promptFrame(context)).not.toContain(lang === 'ja' ? '回答を入力してください' : 'Enter your answer'));
      }
      context.app.stdin.write(ENTER);
      await waitFor(() => expect(client.commands()).toEqual([{ kind: 'answer_question', target, questionId: question.id,
        answer: { report, text: comment } }]));
      const operationId = await client.operation();
      client.output({ kind: 'result', operationId, result: { kind: 'answer_saved', message: 'Answer stored', answerSaved: true } });
      const choice = getLabel(`manager.answerChoices.${report}`, lang);
      const content = comment.trim() === '' ? choice : `${choice}\n${comment}`;
      await waitFor(() => {
        expect(entries().filter((entry) => entry.role === 'user')).toEqual([{ role: 'user', content }]);
        expect(context.app.lastFrame()).toContain(choice);
      });
    });
  });
});
