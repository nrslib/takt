import { randomUUID } from 'node:crypto';
import { conversationId } from '../../infra/conversations/identity.js';
import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import { ManagerClientDouble, mount, showProposal, waitFor, summaryA, approveSummary, promptFrame } from './manager-tui-fixtures.js';
import { getLabel } from '../../shared/i18n/index.js';

it.each(['ja', 'en'] as const)('shows the experimental notice and assignment without sending a provider request in %s', async (lang) => {
  const context = mount(lang);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('manager-repository');
    expect(context.app.lastFrame()!.replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
  });
  expect(context.client.submit).not.toHaveBeenCalled();
});

it.each([40, 80])('keeps Japanese guidance and the experimental notice within %i columns', async (width) => {
  const context = mount('ja');
  Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: width });
  context.app.stdout.emit('resize');
  await waitFor(() => {
    const frame = context.app.lastFrame()!;
    for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    expect(frame.replace(/\s+/gu, '')).toContain(getLabel('manager.inputHint', 'ja').replace(/\s+/gu, ''));
    expect(frame.replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', 'ja').replace(/\s+/gu, ''));
  });
});

it.each(['ja', 'en'] as const)('shows two separate guidance lines with only the supported keys at width 120 in %s', async (lang) => {
  const context = mount(lang);
  Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: 120 });
  context.app.stdout.emit('resize');
  await waitFor(() => {
    const rows = context.app.lastFrame()!.split('\n');
    const end = rows.map((row) => row.startsWith('╰')).lastIndexOf(true);
    expect(end).toBeGreaterThan(0);
    const hints = rows.slice(end + 1).map((row) => row.trimEnd()).filter(Boolean);
    expect(hints).toHaveLength(2);
    if (lang === 'ja') expect(hints).toEqual([
      'Enter 送信  Shift+Enter 改行  Esc 中断  ^R 問い合わせ  ^G ゴール  ^C 終了',
      '/make-goal でゴールの登録案を作る',
    ]);
    else {
      expect(hints[0]).toMatch(/^Enter Send  Shift\+Enter Newline  Esc Interrupt  \^R Inquiries  \^G Goals  \^C Exit$/u);
      expect(hints[1]).toContain('/make-goal');
      expect(hints[1]).toMatch(/creat|prepar|generat/iu);
      expect(hints[1]).toMatch(/goal/iu);
      expect(hints[1]).toMatch(/\b(?:proposal|draft)\b/iu);
      expect(hints[1]).toMatch(/\bregist(?:er|ration)\b/iu);
      expect(hints[1]).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
    }
    for (const row of rows) expect(row).not.toMatch(/\^[ONP]|Ctrl\+[ONP]/iu);
  });
});

it.each(['ja', 'en'] as const)('hides goal-generation guidance while showing approval guidance in %s', async (lang) => {
  const context = mount(lang);
  await waitFor(() => expect(promptFrame(context)).toContain(getLabel('manager.makeGoalHint', lang)));
  await showProposal(context);
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain(summaryA.objective);
    const footer = promptFrame(context).split('╰').at(-1)!;
    expect(footer).toContain(getLabel('manager.summaryInputHint', lang));
    expect(footer).not.toMatch(/\/make-goal\b/u);
  });
});

it.each(['ja', 'en'] as const)('wraps guidance only between whole key items at width 80 in %s', async (lang) => {
  const context = mount(lang);
  Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: 80 });
  context.app.stdout.emit('resize');
  const items = lang === 'ja'
    ? ['Enter 送信', 'Shift+Enter 改行', 'Esc 中断', '^R 問い合わせ', '^G ゴール', '^C 終了']
    : ['Enter Send', 'Shift+Enter Newline', 'Esc Interrupt', '^R Inquiries', '^G Goals', '^C Exit'];
  await waitFor(() => {
    const rows = context.app.lastFrame()!.split('\n');
    const end = rows.map((row) => row.startsWith('╰')).lastIndexOf(true);
    expect(end).toBeGreaterThan(0);
    const hints = rows.slice(end + 1).map((row) => row.trim()).filter(Boolean);
    expect(hints.at(-1)).toContain('/make-goal');
    expect(hints.slice(0, -1).flatMap((row) => row.split(/ {2,}/u))).toEqual(items);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(80);
  });
});

const completionRows = (frame: string): string[] => frame.split('\n').filter((row) => /^(?:❯| ) \/\S+/u.test(row));

it.each(['ja', 'en'] as const)('offers only /make-goal with its description below the input at width 80 in %s', async (lang) => {
  const context = mount(lang);
  Object.defineProperty(context.app.stdout, 'columns', { configurable: true, value: 80 });
  context.app.stdout.emit('resize');
  context.app.stdin.write('/');
  await waitFor(() => {
    const frame = context.app.lastFrame()!;
    const candidates = completionRows(frame);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatch(/^❯ \/make-goal  \S.+/u);
    expect(candidates[0]).toMatch(lang === 'ja' ? /ゴール.*(?:登録|案)/u : /goal/iu);
    const rows = frame.split('\n');
    const promptEnd = rows.map((row) => row.startsWith('╰')).lastIndexOf(true);
    const candidate = rows.indexOf(candidates[0]!);
    expect(candidate).toBe(promptEnd + 1);
    expect(rows[candidate + 1]).toContain('Enter');
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(80);
  });
  expect(context.client.submit).not.toHaveBeenCalled();
});

it('accepts /ma with Tab without sending, then executes /make-goal on Enter', async () => {
  const context = mount();
  context.app.stdin.write('/ma');
  await waitFor(() => expect(completionRows(context.app.lastFrame()!)).toHaveLength(1));
  context.app.stdin.write('\t');
  await waitFor(() => {
    const rows = context.app.lastFrame()!.split('\n');
    expect(rows.some((row) => /│\s*❯ \/make-goal\s*│/u.test(row))).toBe(true);
    expect(completionRows(context.app.lastFrame()!)).toEqual([]);
  });
  expect(context.client.submit).not.toHaveBeenCalled();
  context.app.stdin.write('\r');
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: getLabel('manager.goSummaryRequest', 'en'), display: false }]));
});

it.each(['/xyz', 'こんにちは', '説明 /ma', '> /ma', '`/ma`', '~~~\n/ma\n~~~'])('keeps %j as a draft without slash candidates', async (text) => {
  const context = mount();
  context.app.stdin.write('\x1b[200~' + text + '\x1b[201~');
  await waitFor(() => expect(context.app.lastFrame()).toContain(text.split('\n')[0]!));
  expect(completionRows(context.app.lastFrame()!)).toEqual([]);
  expect(context.client.submit).not.toHaveBeenCalled();
});

it('hides completions with Escape and shows them again after editing the same draft', async () => {
  const context = mount();
  context.app.stdin.write('/');
  await waitFor(() => expect(completionRows(context.app.lastFrame()!)).toHaveLength(1));
  context.app.stdin.write('\x1b[27u');
  await waitFor(() => expect(completionRows(context.app.lastFrame()!)).toEqual([]));
  context.app.stdin.write('m');
  await waitFor(() => expect(completionRows(context.app.lastFrame()!)).toHaveLength(1));
  expect(context.client.submit).not.toHaveBeenCalled();
});

it.each(['reading', 'incomplete'] as const)('never approves a displayed proposal while the same read is %s', async (readStatus) => {
  const context = mount();
  await showProposal(context);
  context.client.change({ readStatus });
  approveSummary(context);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.' + readStatus, 'en')));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ readStatus: 'complete' });
  await waitFor(() => expect(context.app.lastFrame()).not.toContain(getLabel('manager.conversation.' + readStatus, 'en')));
  approveSummary(context);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
});

it('keeps the same screen and proposal while disconnected, then enables approval only after the new complete read', async () => {
  const context = mount();
  await showProposal(context);
  context.client.change({ connection: 'disconnected', readStatus: 'incomplete' });
  approveSummary(context);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.disconnected', 'en')));
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ connection: 'connected', readStatus: 'reading' });
  approveSummary(context);
  expect(context.client.submit).not.toHaveBeenCalled();
  context.client.change({ readStatus: 'complete' });
  await waitFor(() => {
    expect(context.app.lastFrame()).not.toContain(getLabel('manager.conversation.reading', 'en'));
    expect(context.app.lastFrame()).not.toContain(getLabel('manager.conversation.incomplete', 'en'));
  });
  approveSummary(context);
  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'approve_summary', revision: 4 }]));
});

it('displays the interruption state and preserves the conversation identity while accepting a new message', async () => {
  const client = new ManagerClientDouble();
  const conversationId = client.getSnapshot().state!.conversationId;
  client.change({ state: { ...client.getSnapshot().state!, interrupted: true } });
  const context = mount('en', client);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.interrupted', 'en')));
  context.app.stdin.write('Continue after restart\r');
  await waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'Continue after restart' }]));
  expect(client.getSnapshot().state?.conversationId).toBe(conversationId);
});

it.each(['ja', 'en'] as const)('projects new notices once while preserving assignment and counts on the same screen in %s', async (lang) => {
  const context = mount(lang);
  const assignment = context.client.getSnapshot().items[0]!;
  context.client.change({ items: [assignment,
    { kind: 'display_event', event: { id: 'new', message: 'New work record' } },
  ] });
  await waitFor(() => expect(context.app.lastFrame()).toContain('New work record'));
  context.client.change({ items: [...context.client.getSnapshot().items] });
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(context.app.lastFrame()).not.toContain('Historical record');
  expect(context.app.lastFrame()!.match(/New work record/gu)).toHaveLength(1);
  expect(context.client.refresh).toHaveBeenCalled();
  const rows = context.app.lastFrame()!.split('\n');
  const heading = rows.indexOf(getLabel('manager.assignmentHeading', lang, { name: 'manager-repository' }));
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(rows[heading + 1]).toBe(getLabel('manager.counts', lang, { goals: '0', questions: '0' }));
});

it('shows a failed read without replacing the prior complete data with an empty assignment', async () => {
  const context = mount();
  await showProposal(context, summaryA);
  context.client.change({ error: 'Read failed', readStatus: 'incomplete' });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('Read failed');
    expect(context.app.lastFrame()).toContain(summaryA.objective);
    expect(context.app.lastFrame()).toContain('manager-repository');
  });
  context.client.change({ error: null, readStatus: 'complete' });
  expect(context.client.getSnapshot().state?.pending?.summary).toEqual(summaryA);
});

it('follows a replacement assignment in the same mounted screen', async () => {
  const context = mount();
  const old = context.client.getSnapshot().state!;
  const workspaceId = randomUUID();
  context.client.change({ state: { ...old, assignment: { kind: 'workspace', workspaceId }, conversationId: conversationId({ kind: 'workspace', workspaceId }) },
    items: [{ kind: 'assignment', assignment: { kind: 'workspace', workspaceId, name: 'Current workspace',
      repositoryDirectories: ['/work/current-repository'] } }] });
  await waitFor(() => {
    expect(context.app.lastFrame()).toContain('current-repository');
    expect(context.app.lastFrame()).not.toContain('manager-repository');
  });
});
