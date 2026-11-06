import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToString } from 'ink';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptEntryView, TranscriptView } from '../features/tui/TranscriptEntryView.js';
import type { OperationResult, PortOutput } from '../features/manager/conversationPort.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../features/tui/terminalColors.js';
import { stripAnsi } from '../shared/utils/text.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { cwd, DOWN, ENTER, ManagerClientDouble, mount, promptFrame, QUESTION_MENU, waitFor } from './helpers/manager-tui-fixtures.js';

vi.mock('../features/tui/TranscriptEntryView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/TranscriptEntryView.js')>();
  return { ...actual, TranscriptView: vi.fn((props: Parameters<typeof actual.TranscriptView>[0]) =>
    createElement(actual.TranscriptView, props)) };
});

const entries = () => vi.mocked(TranscriptView).mock.calls.at(-1)![0].entries;

describe.each(['ja', 'en'] as const)('manager view (%s)', (lang) => {
  it('shows queued acceptance as a system notice without an assistant marker', async () => {
    const { app, client } = mount(lang);
    client.submit.mockResolvedValueOnce({ kind: 'accepted', operationId: randomUUID(), queuedMessageCount: 1 });
    app.stdin.write('Hello\r');
    const content = getLabel('manager.conversation.queued', lang, { count: '1' });
    await waitFor(() => expect(entries()).toContainEqual({ role: 'system', content }));
    expect(app.lastFrame()).not.toContain('●');
  });

  it.each(['reply', 'progress', 'notice'] as const)('distinguishes daemon %s output by kind even with identical text', async (kind) => {
    const { app, client } = mount(lang);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', lang)));
    const message = 'Shared output';
    const operationId = randomUUID();
    const output: PortOutput = kind === 'notice' ? { kind, id: randomUUID(), message } : { kind, operationId, message };
    client.output(output);
    const role = kind === 'reply' ? 'assistant' : 'system';
    await waitFor(() => expect(entries()).toEqual([{ role, content: message }]));
    expect(app.lastFrame()).toContain(`${kind === 'reply' ? '●' : ' '} ${message}`);
    if (kind !== 'reply') expect(app.lastFrame()).not.toContain('●');
  });

  it.each<OperationResult>([
    { kind: 'reply', message: 'Shared result' },
    { kind: 'notice', message: 'Shared result' },
    { kind: 'answer_saved', answerSaved: true, message: 'Shared result' },
    { kind: 'error', code: 'operation_failed', message: 'Shared result' },
    { kind: 'goal_registered', goal: goalRecord() },
  ])('distinguishes $kind operation results from manager replies', async (result) => {
    const { app, client } = mount(lang);
    await waitFor(() => expect(app.lastFrame()).toContain(getLabel('manager.inputHint', lang)));
    client.output({ kind: 'result', operationId: randomUUID(), result });
    await waitFor(() => {
      expect(entries()).toHaveLength(1);
      expect(entries()[0]!.role).toBe(result.kind === 'reply' ? 'assistant' : 'system');
    });
    if (result.kind === 'reply') expect(app.lastFrame()).toContain('● Shared result');
    else expect(app.lastFrame()).not.toContain('●');
  });

  it('shows saved display events and snapshot errors as system notices', async () => {
    const { app, client } = mount(lang);
    client.change({ error: 'Read failed', items: [...client.getSnapshot().items,
      { kind: 'display_event', event: { id: 'saved-notice', message: 'Saved notification' } }] });
    await waitFor(() => expect(entries()).toEqual([
      { role: 'system', content: 'Read failed' }, { role: 'system', content: 'Saved notification' },
    ]));
    expect(app.lastFrame()).not.toContain('●');
  });

  it('shows the full startup notice once before conversation output without adding it to messages or commands', async () => {
    const { app, client } = mount(lang);
    const notice = getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, '');
    const checkNotice = (): void => {
      const text = app.lastFrame()!.replace(/\s+/gu, '');
      expect(text.startsWith(notice)).toBe(true);
      expect(text.split(notice)).toHaveLength(2);
      expect(app.lastFrame()!.split('\n').at(-1)).not.toMatch(/実験的|experimental/iu);
    };
    await waitFor(checkNotice);
    expect(entries()).toEqual([]);
    expect(client.submit).not.toHaveBeenCalled();
    client.output({ kind: 'reply', operationId: randomUUID(), message: 'Conversation reply' });
    await waitFor(() => expect(app.lastFrame()).toContain('Conversation reply'));
    checkNotice();
    expect(entries()).toEqual([{ role: 'assistant', content: 'Conversation reply' }]);
    app.stdin.write('Hello\r');
    await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'Hello' }]));
    checkNotice();
  });

  it.each([24, 40, 80])('wraps the full yellow startup notice within %i columns', (columns) => {
    const level = chalk.level;
    try {
      chalk.level = 3;
      const output = renderToString(createElement(TranscriptView, {
        entries: [], startupNotice: getLabel('manager.experimentalNotice', lang),
        userMessageColors: FALLBACK_USER_MESSAGE_COLORS,
      }), { columns });
      expect(output).toContain('\x1b[33m');
      const text = stripAnsi(output);
      expect(text.replace(/\s+/gu, '')).toBe(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
      for (const row of text.split('\n')) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    } finally { chalk.level = level; }
  });

  it('shows assignment and counts on one bottom row after the key hints', async () => {
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
    const status = [heading, counts].join(' | ');
    await waitFor(() => {
      const rows = context.app.lastFrame()!.split('\n');
      expect(rows.slice(-2)).toEqual([getLabel('manager.inputHint', lang), status]);
      expect(rows.filter((row) => row.includes(heading) || row.includes(counts))).toEqual([status]);
      expect(rows.join('\n')).not.toContain('/make-goal');
      expect(rows.join('').replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
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
    ].join(' | ')));
    expect(app.lastFrame()).not.toContain('manager-repository');
  });

  it.each(lang === 'ja' ? [36, 38] : [38, 40])('preserves the status suffix with a truncated ordinary assignment heading within %i columns', async (columns) => {
    const { app } = mount(lang);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const status = rows.at(-1)!;
      const [heading] = status.split(' | ');
      const counts = getLabel('manager.counts', lang, { goals: '0', questions: '0' });
      expect(heading).toContain('…');
      expect(status.split(' | ')).toEqual([heading, counts]);
      expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it.each([52, 80])('truncates only the assignment heading and preserves counts within %i columns', async (columns) => {
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
      const [heading, counts] = status.split(' | ');
      expect(heading).toContain('…');
      expect(counts).toBe(getLabel('manager.counts', lang, { goals: '0', questions: '0' }));
      expect(rows.filter((row) => row.includes(counts!))).toEqual([status]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it.each(lang === 'ja' ? [24, 28, 30] : [26, 30, 32])('shows the assignment above counts within %i columns', async (columns) => {
    const name = `開発-${'repository'.repeat(10)}-末尾`;
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory, repositoryDirectories: [repositoryDirectory],
    } }, { kind: 'goal', goal: { ...goalRecord(), repositoryDirectory } }, { kind: 'inquiry', inquiry: {
      question: createInquiry({ body: 'Pending question' }),
      target: { goalId: null, owner: { kind: 'repository', repositoryDirectory } },
    } }] });
    const { app } = mount(lang, client);
    Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
    app.stdout.emit('resize');
    const fullHeading = getLabel('manager.assignmentHeading', lang, { name });
    const counts = getLabel('manager.counts', lang, { goals: '1', questions: '1' });
    const details = counts;
    await waitFor(() => {
      const rows = app.lastFrame()!.split('\n');
      const heading = rows.at(-2)!.trimEnd();
      const [start, end] = heading.split('…');
      expect(start!.length).toBeGreaterThan(0);
      expect(end!.length).toBeGreaterThan(0);
      expect(fullHeading.startsWith(start!)).toBe(true);
      expect(fullHeading.endsWith(end!)).toBe(true);
      expect(rows.at(-1)).toBe(details);
      expect(rows.filter((row) => row.includes(counts))).toEqual([details]);
      for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
    });
  });

  it('truncates the second status row at the end on very narrow terminals', async () => {
    const name = '開発repository'.repeat(10);
    const repositoryDirectory = `/test/${name}`;
    const client = new ManagerClientDouble({ items: [{ kind: 'assignment', assignment: {
      kind: 'repository', repositoryDirectory, repositoryDirectories: [repositoryDirectory],
    } }] });
    const { app } = mount(lang, client);
    const counts = getLabel('manager.counts', lang, { goals: '0', questions: '0' });
    const details = counts;
    for (const columns of [1, 2, 8, 12]) {
      Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
      app.stdout.emit('resize');
      await waitFor(() => {
        const rows = app.lastFrame()!.split('\n').slice(-2);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('…');
        const truncatedDetails = rows[1]!.trimEnd();
        expect(truncatedDetails).toMatch(/…$/u);
        expect(details.startsWith(truncatedDetails.slice(0, -1))).toBe(true);
        for (const row of rows) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
      });
    }
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
    for (const columns of [80, 60, 120]) {
      Object.defineProperty(app.stdout, 'columns', { configurable: true, value: columns });
      app.stdout.emit('resize');
      await waitFor(() => {
        const rows = app.lastFrame()!.split('\n');
        const status = rows.at(-1)!;
        const [heading] = status.split(' | ');
        expect(status.split(' | ')).toEqual([heading, counts]);
        const [start, end] = heading!.trimEnd().split('…');
        expect(start!.length).toBeGreaterThan(0);
        expect(end!.length).toBeGreaterThan(0);
        expect(fullHeading.startsWith(start!)).toBe(true);
        expect(fullHeading.slice(-end!.length)).toBe(end);
        expect(rows.filter((row) => row.includes(counts))).toEqual([status]);
        for (const row of rows.slice(rows.findIndex((row) => row.startsWith('╭')))) expect(measureWidth(row)).toBeLessThanOrEqual(columns);
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

it.each(['system', 'assistant'] as const)('renders %s entries at width 80 with the corresponding marker and dim style', (role) => {
  const level = chalk.level;
  try {
    chalk.level = 3;
    const content = 'First line\nSecond line';
    const output = renderToString(createElement(TranscriptEntryView, {
      entry: { role, content }, userMessageColors: FALLBACK_USER_MESSAGE_COLORS,
    }), { columns: 80 });
    const text = stripAnsi(output);
    expect(text).toBe(`${role === 'assistant' ? '●' : ' '} First line\n  Second line\n`);
    if (role === 'system') {
      expect(output).toContain('\x1b[2m');
      expect(text).not.toContain('●');
    } else {
      expect(output).not.toContain('\x1b[2m');
      expect(output).toContain('\x1b[37m● ');
    }
  } finally { chalk.level = level; }
});
