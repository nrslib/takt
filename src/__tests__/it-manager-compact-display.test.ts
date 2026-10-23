import { cleanup, render } from 'ink-testing-library';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import type { ManagerConversationSession } from '../features/manager/conversationSession.js';
import * as savedEvents from '../features/manager/savedEvents.js';
import { PromptInput } from '../features/tui/PromptInput.js';
import { TranscriptView } from '../features/tui/TranscriptEntryView.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import type { GoalQuestion } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { appendGoalWorkLog } from '../infra/goals/workLog.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('../features/tui/PromptInput.js', async (original) => {
  const actual = await original<typeof import('../features/tui/PromptInput.js')>();
  return { ...actual, PromptInput: vi.fn(actual.PromptInput) };
});

vi.mock('../features/tui/TranscriptEntryView.js', async (original) => {
  const actual = await original<typeof import('../features/tui/TranscriptEntryView.js')>();
  return { ...actual, TranscriptView: vi.fn((props: Parameters<typeof actual.TranscriptView>[0]) =>
    createElement(actual.TranscriptView, props)) };
});

const questionId = '650e8400-e29b-41d4-a716-446655440001';
const nextQuestionId = '650e8400-e29b-41d4-a716-446655440002';
const objective = '共通のゴール名をすべての一覧で同じように短く表示するための長い目的';
const shortName = [...objective].slice(0, 23).join('') + '…';
const body = '出力形式を選んでください。\n' + '詳細な条件を確認します。'.repeat(6) + '本文の末尾';
const question = (overrides: Partial<GoalQuestion>): GoalQuestion => ({
  id: questionId, recipient: 'human', status: 'pending', body,
  options: ['CSV形式', 'JSON形式'], recommendation: 'CSV形式を推奨します', ...overrides,
});

function boxes(frame: string): string[] {
  return frame.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
}

function contentRows(box: string | undefined): string[] {
  expect(box).toBeDefined();
  return box!.split('\n').slice(1, -1).map((row) => row.replace(/^│\s*|\s*│$/gu, ''));
}

function waitFor(assertions: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertions, { timeout: 4000 });
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(PromptInput).mockClear(); vi.mocked(TranscriptView).mockClear();
});

describe('manager polling and answer cancellation', () => {
  let cwd: string;
  let store: GoalStore;
  let app: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'manager-compact-')));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    question: false\n');
    invalidateResolvedConfigCache(cwd);
    store = new GoalStore(cwd);
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    invalidateResolvedConfigCache(cwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  function mount(lang: 'ja' | 'en') {
    const unused = async (): Promise<never> => { throw new Error('Unexpected manager operation'); };
    const answerQuestion = vi.fn<ManagerConversationSession['answerQuestion']>(unused);
    const pauseGoal = vi.fn<ManagerConversationSession['pauseGoal']>(unused);
    const resumeGoal = vi.fn<ManagerConversationSession['resumeGoal']>(unused);
    const abortGoal = vi.fn<ManagerConversationSession['abortGoal']>(unused);
    const session: ManagerConversationSession = {
      getAssignment: async () => undefined, getPendingSummary: () => null, resetConversation: () => {},
      dismissSummary: () => {}, handleUserMessage: unused, approveSummary: unused, answerQuestion,
      pauseGoal, resumeGoal, abortGoal, close: async () => {},
    };
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: ['会話ログの目印'], onExit: vi.fn() }));
    return { answerQuestion, pauseGoal, resumeGoal, abortGoal, read };
  }

  const prompt = () => vi.mocked(PromptInput).mock.calls.at(-1)![0];
  const transcript = () => vi.mocked(TranscriptView).mock.calls.at(-1)![0].entries;
  const answerDialogs = () => boxes(app!.lastFrame()!).filter((box) => box.includes('本文の末尾')
    && /Free text|Enter your answer|自由記述|回答を入力してください/u.test(box));

  async function openAnswer(): Promise<void> {
    app!.stdin.write('\x12');
    await waitFor(() => expect(boxes(app!.lastFrame()!).some((box) => /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box))).toBe(true));
    app!.stdin.write('\r');
    await waitFor(() => {
      expect(prompt().placeholder).toMatch(/Enter your answer|回答を入力してください/u);
      expect(answerDialogs()).toHaveLength(1);
    });
  }

  async function createGoalsWithHistory() {
    return Promise.all(['最初のゴール', '次のゴール'].map((name, goalIndex) => store.create({
      ...goalRecord(), id: `750e8400-e29b-41d4-a716-44665544000${goalIndex}`, objective: name,
      workLog: Array.from({ length: 30 }, (_, index) => ({
        id: `850e8400-e29b-41d4-a716-${String(goalIndex * 30 + index).padStart(12, '0')}`, recordedAt: '2026-10-14T00:00:00Z',
        summary: `起動前の記録${name}${index}: ${'過去の作業内容。'.repeat(20)}記録末尾${index}`,
      })),
    })));
  }

  it.each(['repository', 'goal'] as const)('keeps startup history suppressed after a %s diagnostic recovers', async (failure) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
    const goals = await createGoalsWithHistory();
    const goalFile = join(cwd, '.takt', 'goals', goals[1]!.id, 'goal.json');
    const list = failure === 'repository'
      ? vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('repository read failed')) : undefined;
    if (failure === 'goal') writeFileSync(goalFile, '{}');
    const { read } = mount('en');

    await waitFor(() => expect(read).toHaveBeenCalled());
    const initial: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results[0]!.value;
    expect(initial.diagnostics.length).toBeGreaterThan(0);
    if (failure === 'goal') {
      expect(initial.goals.map((goal) => goal.id)).toEqual([goals[0]!.id]);
      expect(initial.diagnostics.some((event) => event.message.includes(goalFile))).toBe(true);
    } else expect(initial.events).toEqual([]);
    await waitFor(() => {
      for (const diagnostic of initial.diagnostics) {
        expect(transcript().some((entry) => entry.content === diagnostic.message)).toBe(true);
      }
    });

    if (list !== undefined) list.mockRestore();
    else writeFileSync(goalFile, JSON.stringify(goals[1]));
    await waitFor(async () => {
      const recovered: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results.at(-1)!.value;
      expect(recovered.diagnostics).toEqual([]);
      expect(recovered.events).toHaveLength(60);
      expect(recovered.goals.map((goal) => goal.id)).toEqual(expect.arrayContaining(goals.map((goal) => goal.id)));
    });
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));
    for (const [props] of vi.mocked(TranscriptView).mock.calls) {
      expect(props.entries.filter((entry) => goals.some((goal) => entry.content.startsWith(`${goal.id}: `)
        && !initial.diagnostics.some((event) => event.message === entry.content)))).toEqual([]);
    }
    for (const diagnostic of initial.diagnostics) {
      expect(transcript().filter((entry) => entry.content === diagnostic.message))
        .toHaveLength(initial.diagnostics.filter((event) => event.message === diagnostic.message).length);
    }
  });

  it('displays a new record exactly once after the initial read rejects', async () => {
    const goals = await createGoalsWithHistory();
    const startedAt = Date.parse('2026-10-21T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    const actualRead = savedEvents.readManagerDisplayEvents;
    const { read } = mount('en');
    read.mockRejectedValue(new Error('initial display read rejected'));
    await waitFor(() => expect(transcript().some((entry) => entry.content === 'initial display read rejected')).toBe(true));

    vi.setSystemTime(startedAt + 1000);
    const summary = '拒否中に追加した通常記録\n' + '新着の詳細。'.repeat(30) + '新着末尾';
    await store.update(goals[1]!.id, (goal) => appendGoalWorkLog(goal, { summary }));
    vi.setSystemTime(startedAt + 5000);
    read.mockImplementation(actualRead);
    await waitFor(async () => {
      const recovered: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results.at(-1)!.value;
      expect(recovered.events).toHaveLength(61);
      expect(recovered.diagnostics).toEqual([]);
    });
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));
    expect(transcript().filter((entry) => entry.content === `${goals[1]!.id}: ${summary}`)).toHaveLength(1);
    for (const [props] of vi.mocked(TranscriptView).mock.calls) {
      for (const entry of props.entries) {
        expect(entry.content).not.toContain('起動前の記録');
        if (goals.some((goal) => entry.content.startsWith(`${goal.id}: `))) {
          expect(entry.content).toBe(`${goals[1]!.id}: ${summary}`);
        }
      }
    }
  });

  it.each([true, false])('distinguishes the same record by saving before startup=%s after a rejected read', async (beforeStartup) => {
    const goals = await createGoalsWithHistory();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T09:59:59Z'));
    const goalId = goals[0]!.id;
    const save = () => store.update(goalId, (goal) => appendGoalWorkLog(goal, { summary: '作業報告\n詳細' }));
    if (beforeStartup) await save();
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    const actualRead = savedEvents.readManagerDisplayEvents;
    const { read } = mount('en');
    read.mockRejectedValue(new Error('initial display read rejected'));
    await waitFor(() => expect(transcript().some((entry) => entry.content === 'initial display read rejected')).toBe(true));
    if (!beforeStartup) {
      vi.setSystemTime(new Date('2026-10-21T10:00:01Z'));
      await save();
    }
    vi.setSystemTime(new Date('2026-10-21T10:00:05Z'));
    read.mockImplementation(actualRead);
    await waitFor(async () => {
      const recovered: Awaited<ReturnType<typeof savedEvents.readManagerDisplayEvents>> = await read.mock.results.at(-1)!.value;
      expect(recovered.events).toHaveLength(61);
      expect(recovered.diagnostics).toEqual([]);
      expect(transcript().filter((entry) => entry.content.startsWith(`${goalId}: `)))
        .toHaveLength(beforeStartup ? 0 : 1);
    });
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls + 1));
    for (const [props] of vi.mocked(TranscriptView).mock.calls) {
      const records = props.entries.filter((entry) => goals.some((goal) => entry.content.startsWith(`${goal.id}: `)));
      expect(records.length).toBeLessThanOrEqual(beforeStartup ? 0 : 1);
      for (const entry of records) expect(entry.content).toBe(`${goalId}: 作業報告\n詳細`);
    }
    expect(transcript().filter((entry) => entry.content === `${goalId}: 作業報告\n詳細`))
      .toHaveLength(beforeStartup ? 0 : 1);
  });

  it('reads all work records without a startup boundary and limits suppression to startup repositories', async () => {
    const goals = await createGoalsWithHistory();
    const added = join(cwd, 'added');
    mkdirSync(added);
    const addedGoal = await new GoalStore(added).create({ ...goalRecord(), id: randomUUID(), workLog: goals[0]!.workLog });
    const assignment = { kind: 'workspace' as const, workspaceId: randomUUID(), name: 'Startup workspace',
      repositoryDirectories: [cwd, added] };
    const all = await savedEvents.readManagerDisplayEvents(cwd, 'en', assignment);
    expect(all.events).toHaveLength(90);
    for (const event of all.events) expect(event.suppressInitialDisplay).toBeUndefined();
    const bounded = await savedEvents.readManagerDisplayEvents(cwd, 'en', assignment,
      new Map([[cwd, Date.now()]]));
    expect(bounded.events).toHaveLength(90);
    const addedEvents = bounded.events.filter((event) => event.message.startsWith(`${addedGoal.id}: `));
    expect(addedEvents).toHaveLength(30);
    for (const event of addedEvents) expect(event.suppressInitialDisplay).toBeUndefined();
    expect(bounded.events.filter((event) => event.suppressInitialDisplay)).toHaveLength(60);
  });

  it.each(['ja', 'en'] as const)('suppresses historical work records but keeps notices, diagnostics and new records in the same screen in %s', async (lang) => {
    const goals = await createGoalsWithHistory();
    const notice = '初回にも表示する通知';
    await store.update(goals[0]!.id, (goal) => ({ ...goal, notifications: [{
      id: randomUUID(), recordedAt: '2026-10-14T00:00:00Z', kind: 'custom', body: notice,
    }] }));
    const broken = await store.create({ ...goalRecord(), id: randomUUID() });
    const brokenFile = join(cwd, '.takt', 'goals', broken.id, 'goal.json');
    writeFileSync(brokenFile, '{}');
    const { read } = mount(lang);
    await waitFor(() => {
      expect(transcript().some((entry) => entry.content.includes(notice))).toBe(true);
      expect(transcript().some((entry) => entry.content.includes(brokenFile))).toBe(true);
    });

    const newSummary = '起動後に届いた作業の全文\n' + '新着の詳細。'.repeat(30) + '新着末尾';
    await store.update(goals[1]!.id, (goal) => appendGoalWorkLog(goal, { summary: newSummary }));
    await waitFor(() => expect(transcript().filter((entry) => entry.content === `${goals[1]!.id}: ${newSummary}`)).toHaveLength(1));
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));

    for (const [props] of vi.mocked(TranscriptView).mock.calls) {
      for (const entry of props.entries) expect(entry.content).not.toContain('起動前の記録');
    }
    expect(transcript().filter((entry) => entry.content.includes(notice))).toHaveLength(1);
    expect(transcript().filter((entry) => entry.content === `${goals[1]!.id}: ${newSummary}`)).toHaveLength(1);
    for (const goal of goals) expect((await store.get(goal.id)).workLog.slice(0, 30)).toEqual(goal.workLog);
  });

  const countLine = (lang: 'ja' | 'en'): string => {
    const rows = app!.lastFrame()!.split('\n')
      .filter((row) => (lang === 'ja' ? /進行中/u : /in progress|ongoing|active/iu).test(row) && /\^R/u.test(row));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  it.each(['ja', 'en'] as const)('shows two ongoing goals and four inquiries with all menu keys on one line in %s', async (lang) => {
    await store.create({ ...goalRecord(), questions: [question({}), question({ id: nextQuestionId })] });
    await store.create({ ...goalRecord(), id: randomUUID(), executionStatus: 'paused',
      questions: [question({ id: randomUUID() })] });
    await new StandaloneInquiryStore(getGlobalConfigDir(), { kind: 'repository', repositoryDirectory: cwd })
      .create({ body: 'ゴールなしの問い合わせ' });
    mount(lang);
    await waitFor(() => {
      const line = countLine(lang);
      expect(line).toMatch(lang === 'ja' ? /進行中\s*2/u : /(?:in progress|ongoing|active)\s*:?\s*2/iu);
      expect(line).toMatch(lang === 'ja' ? /未回答\s*4/u : /(?:pending|unanswered)\s*:?\s*4/iu);
      expect(line).toMatch(/\^R.*\^G.*\^O/u);
      expect(line).toMatch(lang === 'ja' ? /問い合わせ.*ゴール.*要約/u : /inquir|question/iu);
      if (lang === 'en') expect(line).toMatch(/goal.*summary/iu);
    });
  });

  it.each(['ja', 'en'] as const)('keeps the count and menu line visible when both counts are zero in %s', async (lang) => {
    mount(lang);
    await waitFor(() => {
      expect(countLine(lang)).toMatch(lang === 'ja' ? /進行中\s*0.*未回答\s*0/u
        : /(?:in progress|ongoing|active)\s*:?\s*0.*(?:pending|unanswered)\s*:?\s*0/iu);
      expect(countLine(lang)).toMatch(/\^R.*\^G.*\^O/u);
    });
  });

  it.each(['ja', 'en'] as const)('replaces fixed goal and inquiry panels with counts and key guidance in %s', async (lang) => {
    const completion = { goalBranch: 'goal', goalSha: 'a'.repeat(40), targetBranch: 'main',
      targetSha: 'b'.repeat(40), summary: '完成の根拠', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } };
    const names = ['完成した名前', '中止した名前', '進行中の名前'];
    for (const [index, name] of names.entries()) await store.create({
      ...goalRecord(), id: randomUUID(), objective: name,
      status: index === 0 ? 'completed' : 'created', executionStatus: index === 0 ? 'paused' : index === 1 ? 'aborted' : 'active',
      ...(index === 0 ? { completion } : {}),
      questions: index === 2 ? [question({ body: '画面へ固定表示しない問い合わせ本文' })] : [],
    });
    mount(lang);
    await waitFor(() => expect(countLine(lang)).toMatch(lang === 'ja' ? /進行中\s*1.*未回答\s*1/u
      : /(?:in progress|ongoing|active)\s*:?\s*1.*(?:pending|unanswered)\s*:?\s*1/iu));
    const rows = app!.lastFrame()!.split('\n');
    for (const row of rows) {
      for (const name of names) expect(row).not.toContain(name);
      expect(row).not.toContain('画面へ固定表示しない問い合わせ本文');
      expect(row).not.toMatch(/\/(?:go|answer|pause|resume|abort)\b/u);
      expect(row).not.toMatch(/全ゴール|ゴールの状態|中止済みのゴール|一時停止中のゴール|Goal statuses|Aborted goals|Paused goals/iu);
      expect(row).not.toMatch(/provider.*API|API.*(?:費用|cost)/iu);
    }
    expect(rows.join('').replace(/\s+/gu, '')).not.toContain(getLabel('manager.costNotice', lang).replace(/\s+/gu, ''));
    expect(app!.lastFrame()!.replace(/\s+/gu, '')).toContain(getLabel('manager.experimentalNotice', lang).replace(/\s+/gu, ''));
  });

  it.each(['ja', 'en'] as const)('refreshes counts after status and inquiry changes in the same %s screen', async (lang) => {
    const saved = await store.create({ ...goalRecord(), questions: [question({})] });
    mount(lang);
    await waitFor(() => expect(countLine(lang)).toMatch(lang === 'ja' ? /進行中\s*1.*未回答\s*1/u
      : /(?:in progress|ongoing|active)\s*:?\s*1.*(?:pending|unanswered)\s*:?\s*1/iu));
    await store.update(saved.id, (goal) => ({ ...goal, executionStatus: 'paused',
      questions: [...goal.questions!, question({ id: nextQuestionId })] }));
    await waitFor(() => expect(countLine(lang)).toMatch(lang === 'ja' ? /進行中\s*1.*未回答\s*2/u
      : /(?:in progress|ongoing|active)\s*:?\s*1.*(?:pending|unanswered)\s*:?\s*2/iu));
    await store.update(saved.id, (goal) => ({ ...goal, executionStatus: 'aborted' }));
    await waitFor(() => expect(countLine(lang)).toMatch(lang === 'ja' ? /進行中\s*0.*未回答\s*2/u
      : /(?:in progress|ongoing|active)\s*:?\s*0.*(?:pending|unanswered)\s*:?\s*2/iu));
  });

  it.each(['ja', 'en'] as const)('shows only a single-line patrol summary and preserves full ordinary records in %s', async (lang) => {
    const saved = await store.create(goalRecord());
    const { read } = mount(lang);
    await waitFor(() => expect(read).toHaveBeenCalled());
    await read.mock.results[0]!.value;
    await waitFor(() => expect(transcript()).toHaveLength(1));
    const patrol = '  変化なし\n\t' + 'e\u0301👩‍💻'.repeat(60) + '\n巡回の末尾';
    const ordinary = patrol;
    await store.update(saved.id, (goal) => appendGoalWorkLog(appendGoalWorkLog(goal, {
      summary: patrol, kind: 'patrol',
    }), { summary: ordinary }));
    await waitFor(() => {
      expect(transcript().filter((entry) => entry.content.startsWith(`${saved.id}: `))).toHaveLength(2);
      expect(transcript().some((entry) => entry.content === `${saved.id}: ${ordinary}`)).toBe(true);
    });
    expect((await store.get(saved.id)).workLog.map((record) => record.summary)).toEqual([patrol, ordinary]);
    const patrolEntry = transcript().find((entry) => entry.content.startsWith(`${saved.id}: `)
      && entry.content !== `${saved.id}: ${ordinary}`);
    expect(patrolEntry).toBeDefined();
    const summary = patrolEntry!.content.slice(`${saved.id}: `.length);
    expect(summary).toMatch(/^変化なし (?:e\u0301👩‍💻)*(?:e\u0301)?…$/u);
    expect(summary).not.toMatch(/[\r\n\t]| {2}/u);
    expect(summary.length).toBeLessThan(patrol.length);
    expect(summary).not.toContain('巡回の末尾');
  });

  describe.each(['ja', 'en'] as const)('selection lists in %s', (lang) => {
    describe.each([38, 40, 160])('terminal width %i', (columns) => {
      it.each(['answer', 'goal'] as const)('renders compact %s candidates outside the log and Esc leaves the store unchanged', async (command) => {
        const saved = await store.create({ ...goalRecord(), objective,
          executionStatus: 'paused', questions: [question({ kind: 'approval', operation: {
            toolName: 'Bash', args: '{}', cwd, argsDigest: createHash('sha256').update('{}').digest('hex'),
          } })] });
        const file = join(cwd, '.takt', 'goals', saved.id, 'goal.json');
        const before = readFileSync(file, 'utf8');
        const calls = mount(lang);
        vi.spyOn(app!.stdout, 'columns', 'get').mockReturnValue(columns);
        app!.stdin.write(command === 'answer' ? '\x12' : '\x07');
        const list = () => boxes(app!.lastFrame()!).find((box) => /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box));
        await waitFor(() => expect(list()).toBeDefined());
        const selectedBox = list()!;
        if (columns === 160) {
          const rows = contentRows(selectedBox).filter((row) => row.includes(shortName));
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatch(command === 'answer'
            ? (lang === 'ja' ? /承認/u : /approval/iu)
            : (lang === 'ja' ? /実行|一時停止|停止中/u : /active|paused/iu));
        }
        if (columns === 40) {
          const prefix = command === 'goal' ? objective.slice(0, 6) : lang === 'ja' ? '承認' : 'Approval';
          const rows = contentRows(selectedBox).filter((row) => row.startsWith(prefix));
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatch(/…$/u);
        }
        expect(selectedBox).not.toContain(saved.id);
        expect(selectedBox).not.toContain('本文の末尾');
        for (const option of saved.questions![0]!.options!) expect(selectedBox).not.toContain(option);
        expect(app!.lastFrame()!.indexOf('会話ログの目印')).toBeLessThan(app!.lastFrame()!.indexOf(selectedBox));
        for (const line of selectedBox.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
        app!.stdin.write('\x1b[27u');
        await waitFor(() => expect(list()).toBeUndefined());
        for (const call of [calls.answerQuestion, calls.pauseGoal, calls.resumeGoal, calls.abortGoal]) expect(call).not.toHaveBeenCalled();
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(await store.get(saved.id)).toEqual(saved);
      });
    });
  });

  it.each(['ja', 'en'] as const)('shows full details only after opening the answer in %s and preserves saved data', async (lang) => {
    const saved = await store.create({ ...goalRecord(), objective, executionStatus: 'paused', questions: [question({})] });
    const file = join(cwd, '.takt', 'goals', saved.id, 'goal.json');
    const before = readFileSync(file, 'utf8');
    mount(lang);
    await waitFor(() => expect(countLine(lang)).toBeDefined());
    const initialFrame = app!.lastFrame()!;
    await openAnswer();
    const detail = answerDialogs()[0]!;
    const visible = detail.replace(/[│\s]+/gu, '');
    expect(visible).toContain(body.replace(/\s+/gu, ''));
    for (const option of saved.questions![0]!.options!) expect(detail).toContain(option);
    expect(detail).toContain(lang === 'ja' ? '推奨' : 'Recommendation');
    expect(detail).toContain(saved.questions![0]!.recommendation);
    expect(initialFrame).not.toContain('本文の末尾');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it.each([false, true])('keeps the prompt and answer target when another inquiry arrives with an open dialog=%s', async (open) => {
    const saved = await store.create({ ...goalRecord(), questions: [question({})] });
    const { read, answerQuestion } = mount('en');
    await waitFor(() => expect(countLine('en')).toBeDefined());
    if (open) await openAnswer();
    app!.stdin.write('unsent draft');
    await waitFor(() => expect(prompt().text).toBe('unsent draft'));
    const before = { disabled: prompt().disabled, placeholder: prompt().placeholder };
    expect(before).toEqual({ disabled: false, placeholder: open ? 'Enter your answer' : 'Discuss your goal' });
    const polls = read.mock.calls.length;
    await store.update(saved.id, (goal) => ({ ...goal, questions: [...goal.questions!, question({ id: nextQuestionId, body: '新着の問い合わせ' })] }));
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThan(polls);
      expect(countLine('en')).toMatch(/(?:pending|unanswered)\s*:?\s*2/iu);
      expect(prompt()).toMatchObject({ ...before, text: 'unsent draft' });
      const dialogs = answerDialogs();
      expect(dialogs).toHaveLength(open ? 1 : 0);
      if (open) expect(dialogs[0]).toContain('出力形式を選んでください。');
    });
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns from answer details to the list on Esc and keeps the stored inquiry pending with options=%s', async (withOptions) => {
    const inquiry = question(withOptions ? {} : { options: undefined });
    const saved = await store.create({ ...goalRecord(), questions: [inquiry] });
    const file = join(cwd, '.takt', 'goals', saved.id, 'goal.json');
    const before = readFileSync(file, 'utf8');
    const { read, answerQuestion } = mount('en');
    await waitFor(() => expect(countLine('en')).toBeDefined());
    await openAnswer();
    app!.stdin.write('\x1b[27u');
    await waitFor(() => expect(answerDialogs()).toEqual([]));
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(await store.get(saved.id)).toEqual(saved);
    expect((await savedEvents.readManagerDisplayEvents(cwd, 'en')).questions).toEqual([
      { goalId: saved.id, repositoryDirectory: cwd, objective: saved.objective, question: saved.questions![0] },
    ]);
    expect(countLine('en')).toMatch(/(?:pending|unanswered)\s*:?\s*1/iu);
    expect(prompt()).toMatchObject({ disabled: true, placeholder: 'Discuss your goal' });
    const list = boxes(app!.lastFrame()!).find((box) => box.includes(getLabel('manager.selectionTitles.answer', 'en')));
    expect(list).toBeDefined();
    expect(list).toContain('出力形式を選んでください。');
    app!.stdin.write('\r');
    await waitFor(() => expect(answerDialogs()).toHaveLength(1));
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
