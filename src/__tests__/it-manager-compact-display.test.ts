import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerAbortedGoals } from '../features/manager/ManagerAbortedGoals.js';
import { ManagerPausedGoals } from '../features/manager/ManagerPausedGoals.js';
import { ManagerPendingQuestions } from '../features/manager/ManagerPendingQuestions.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import type { ManagerConversationSession } from '../features/manager/conversationSession.js';
import { formatGoalName } from '../features/manager/goalDisplay.js';
import * as savedEvents from '../features/manager/savedEvents.js';
import type { PendingQuestion } from '../features/manager/inquiryAnswer.js';
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

describe.each(['ja', 'en'] as const)('compact manager lists in %s', (lang) => {
  it.each([160, 38])('renders only paused and aborted goals with one row per goal at width %i', async (width) => {
    const goals = [
      { ...goalRecord(), objective, executionStatus: 'paused' as const },
      { ...goalRecord(), id: nextQuestionId, objective: '二つ目の停止対象', executionStatus: 'paused' as const },
      { ...goalRecord(), id: questionId, objective, executionStatus: 'aborted' as const },
      { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440003', objective: '実行中の対象', executionStatus: 'active' as const },
    ];
    const app = render(createElement(Box, { width, flexDirection: 'column' },
      createElement(ManagerPausedGoals, { goals, lang }), createElement(ManagerAbortedGoals, { goals, lang })));

    await waitFor(() => {
      const frames = boxes(app.lastFrame()!);
      expect(frames).toHaveLength(2);
      const paused = contentRows(frames[0]!);
      const aborted = contentRows(frames[1]!);
      expect(paused.filter((row) => row.includes('共通のゴール'))).toHaveLength(1);
      expect(paused.filter((row) => row.includes('二つ目の停止対象'))).toHaveLength(1);
      expect(aborted.filter((row) => row.includes('共通のゴール'))).toHaveLength(1);
      expect(paused).toHaveLength(4);
      expect(aborted).toHaveLength(2);
      if (width === 160) {
        expect(paused.find((row) => row.includes(shortName))).toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
        expect(aborted.find((row) => row.includes(shortName))).toMatch(lang === 'ja' ? /中止/u : /aborted/iu);
      }
      const resume = paused.filter((row) => row.includes('/resume'));
      expect(resume).toHaveLength(1);
      expect(resume[0]).toMatch(/\/resume(?!\s+[\da-f-]{8})/iu);
      for (const row of [...paused, ...aborted]) {
        for (const goal of goals) expect(row).not.toContain(goal.id);
        expect(row).not.toContain('実行中の対象');
        expect(row).not.toContain(objective);
      }
      for (const line of app.lastFrame()!.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    });
  });

  it('shows each inquiry kind, the common name, a short summary and the count without details', async () => {
    const kinds = ['question', 'approval', 'operation_request', undefined] as const;
    const questions: PendingQuestion[] = kinds.map((kind, index) => ({
      goalId: goalRecord().id, repositoryDirectory: '/fixture', objective,
      question: question({ id: `650e8400-e29b-41d4-a716-44665544000${index + 1}`, kind,
        body: `要点${index}\n${'あ'.repeat(60)}本文の末尾` }),
    }));
    const app = render(createElement(Box, { width: 160 }, createElement(ManagerPendingQuestions, { questions, lang })));

    await waitFor(() => {
      const frames = boxes(app.lastFrame()!);
      expect(frames).toHaveLength(1);
      const rows = contentRows(frames[0]!);
      expect(rows[0]).toMatch(/4/u);
      expect(rows).toHaveLength(6);
      const expectedKinds = lang === 'ja' ? [/質問/u, /承認/u, /操作依頼/u, /質問/u]
        : [/question/iu, /approval/iu, /operation request/iu, /question/iu];
      for (const [index, pending] of questions.entries()) {
        const summary = `要点${index} ` + 'あ'.repeat(35) + '…';
        const matching = rows.filter((row) => row.includes(summary));
        expect(matching).toHaveLength(1);
        expect(matching[0]).toContain(shortName);
        expect(matching[0]).toMatch(expectedKinds[index]!);
        for (const row of rows) {
          expect(row).not.toContain(pending.goalId!);
          expect(row).not.toContain(pending.question.id);
          expect(row).not.toContain('本文の末尾');
          for (const option of pending.question.options!) expect(row).not.toContain(option);
          expect(row).not.toContain(pending.question.recommendation!);
        }
      }
      const guidance = rows.filter((row) => row.includes('/answer'));
      expect(guidance).toHaveLength(1);
      expect(guidance[0]).toMatch(/\/answer\b/u);
    });
  });

  it('keeps a Japanese inquiry with a long name and body on one row in a narrow terminal', async () => {
    const questions = [{ goalId: goalRecord().id, repositoryDirectory: '/fixture', objective, question: question({ kind: 'question' }) }];
    const app = render(createElement(Box, { width: 38 }, createElement(ManagerPendingQuestions, { questions, lang })));
    await waitFor(() => {
      const rows = contentRows(boxes(app.lastFrame()!)[0]!);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toMatch(lang === 'ja' ? /質問/u : /question/iu);
      for (const line of app.lastFrame()!.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(38);
    });
  });
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
    app!.stdin.write('/answer');
    await waitFor(() => expect(prompt().text).toBe('/answer'));
    app!.stdin.write('\r');
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

  describe.each(['ja', 'en'] as const)('goal status overview in %s', (lang) => {
    it.each([160, 38])('shows one row per goal with its status and pending count at width %i', async (columns) => {
      const history = await createGoalsWithHistory();
      const completion = { goalBranch: 'goal', goalSha: 'a'.repeat(40), targetBranch: 'main',
        targetSha: 'b'.repeat(40), summary: '完成の根拠',
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
        instructions: [] };
      const states = [
        { status: 'created' as const, executionStatus: 'active' as const, name: objective, count: 2,
          label: getLabel('manager.goalStates.active', lang) },
        { status: 'created' as const, executionStatus: 'paused' as const, name: `一時停止する${objective}`, count: 1,
          label: getLabel('manager.goalStates.paused', lang) },
        { status: 'created' as const, executionStatus: 'aborted' as const, name: '中止対象', count: 0,
          label: getLabel('manager.goalStates.aborted', lang) },
        { status: 'awaiting_merge' as const, executionStatus: 'active' as const, name: 'マージ対象', count: 0,
          label: getLabel('manager.goalStates.awaiting_merge', lang) },
        { status: 'completed' as const, executionStatus: 'active' as const, name: '完了対象', count: 0,
          label: getLabel('manager.goalStates.completed', lang) },
      ];
      for (const [index, state] of states.entries()) {
        const goal = { ...goalRecord(), id: history[index]?.id ?? randomUUID(), objective: state.name,
          status: state.status, executionStatus: state.executionStatus,
          ...(state.status === 'created' ? {} : { completion }),
          workLog: history[index]?.workLog ?? [],
          questions: [
            ...Array.from({ length: state.count }, () => question({ id: randomUUID(), body: '未回答の問い合わせ' })),
            question({ id: randomUUID(), status: 'withdrawn', body: '取り下げた問い合わせ' }),
          ] };
        if (index < history.length) await store.update(goal.id, () => goal);
        else await store.create(goal);
      }
      await new StandaloneInquiryStore(getGlobalConfigDir(), { kind: 'repository', repositoryDirectory: cwd })
        .create({ body: 'ゴールに所属しない問い合わせ' });
      mount(lang);
      vi.spyOn(app!.stdout, 'columns', 'get').mockReturnValue(columns);
      const countLabel = (count: number) => getLabel('manager.goalPendingInquiries', lang, { count: String(count) });

      await waitFor(() => {
        const panels = boxes(app!.lastFrame()!).filter((box) =>
          contentRows(box)[0] === getLabel('manager.goalStatuses', lang));
        expect(panels).toHaveLength(1);
        const rows = contentRows(panels[0]).slice(1);
        expect(rows).toHaveLength(states.length);
        expect(rows.filter((row) => row.includes(countLabel(0)))).toHaveLength(3);
        expect(rows.filter((row) => row.includes(countLabel(1)))).toHaveLength(1);
        expect(rows.filter((row) => row.includes(countLabel(2)))).toHaveLength(1);
        for (const state of states) {
          const matching = rows.filter((row) => row.includes(`${state.label}: `) && row.includes(countLabel(state.count)));
          expect(matching).toHaveLength(1);
          const visibleName = matching[0]!.split(`${state.label}: `)[1];
          expect(visibleName).toContain(columns === 160 ? formatGoalName(state.name) : state.name.slice(0, 2));
        }
        if (columns === 160) {
          expect(panels[0]).not.toContain(objective);
          expect(panels[0]).toContain(shortName);
        }
        for (const line of panels[0]!.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      });
    });

    it('updates the existing goal row after its status and inquiries change', async () => {
      const saved = await store.create({ ...goalRecord(), objective: '更新対象', questions: [question({ body: '更新前の質問' })] });
      mount(lang);
      const countLabel = (count: number) => getLabel('manager.goalPendingInquiries', lang, { count: String(count) });
      const goalRow = () => boxes(app!.lastFrame()!)
        .filter((box) => contentRows(box)[0] === getLabel('manager.goalStatuses', lang))
        .flatMap(contentRows).filter((row) => row.includes(saved.objective));
      await waitFor(() => {
        expect(goalRow()).toHaveLength(1);
        expect(goalRow()[0]).toContain(countLabel(1));
        expect(goalRow()[0]).toMatch(lang === 'ja' ? /実行中|作業中/u : /active|working|in progress/iu);
      });
      await store.update(saved.id, (goal) => ({ ...goal, executionStatus: 'paused', questions: [
        ...goal.questions!, question({ id: nextQuestionId, body: '更新後の質問' }),
      ] }));
      await waitFor(() => {
        expect(goalRow()).toHaveLength(1);
        expect(goalRow()[0]).toContain(countLabel(2));
        expect(goalRow()[0]).toMatch(lang === 'ja' ? /一時停止/u : /paused/iu);
      });
    });
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
    describe.each([38, 160])('terminal width %i', (columns) => {
      it.each(['answer', 'pause', 'resume', 'abort'] as const)('renders compact %s candidates outside the log and Esc leaves the store unchanged', async (command) => {
        const saved = await store.create({ ...goalRecord(), objective,
          executionStatus: command === 'resume' ? 'paused' : 'active', questions: [question({ kind: 'approval', operation: {
            toolName: 'Bash', args: '{}', cwd, argsDigest: createHash('sha256').update('{}').digest('hex'),
          } })] });
        const file = join(cwd, '.takt', 'goals', saved.id, 'goal.json');
        const before = readFileSync(file, 'utf8');
        const calls = mount(lang);
        vi.spyOn(app!.stdout, 'columns', 'get').mockReturnValue(columns);
        app!.stdin.write(`/${command}`);
        await waitFor(() => expect(prompt().text).toBe(`/${command}`));
        app!.stdin.write('\r');
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
    await waitFor(() => expect(app!.lastFrame()).toContain('出力形式を選んでください。'));
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

  it('updates the count and list outside the existing conversation log in the same screen', async () => {
    const saved = await store.create({ ...goalRecord(), objective, questions: [question({ body: '最初の問い合わせ' })] });
    const { read } = mount('ja');
    const pendingBox = () => boxes(app!.lastFrame()!).find((box) => box.includes('最初の問い合わせ'))!;
    await waitFor(() => expect(contentRows(pendingBox())[0]).toMatch(/1/u));
    const polls = read.mock.calls.length;
    await store.update(saved.id, (goal) => ({ ...goal, questions: [...goal.questions!, question({ id: nextQuestionId, body: '次の問い合わせ' })] }));
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThan(polls);
      const box = pendingBox();
      expect(contentRows(box)[0]).toMatch(/2/u);
      expect(box).toContain('最初の問い合わせ');
      expect(box).toContain('次の問い合わせ');
      const frame = app!.lastFrame()!;
      expect(frame).toContain('会話ログの目印');
      expect(frame.indexOf('会話ログの目印')).toBeLessThan(frame.indexOf(box));
      expect(frame.slice(0, frame.indexOf(box))).not.toContain('次の問い合わせ');
    });
  });

  it.each([false, true])('keeps the prompt and answer target when another inquiry arrives with an open dialog=%s', async (open) => {
    const saved = await store.create({ ...goalRecord(), questions: [question({})] });
    const { read, answerQuestion } = mount('en');
    await waitFor(() => expect(app!.lastFrame()).toContain('出力形式を選んでください。'));
    if (open) await openAnswer();
    app!.stdin.write('unsent draft');
    await waitFor(() => expect(prompt().text).toBe('unsent draft'));
    const before = { disabled: prompt().disabled, placeholder: prompt().placeholder };
    expect(before).toEqual({ disabled: false, placeholder: open ? 'Enter your answer' : 'Discuss your goal' });
    const polls = read.mock.calls.length;
    await store.update(saved.id, (goal) => ({ ...goal, questions: [...goal.questions!, question({ id: nextQuestionId, body: '新着の問い合わせ' })] }));
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThan(polls);
      expect(app!.lastFrame()).toContain('新着の問い合わせ');
      expect(prompt()).toMatchObject({ ...before, text: 'unsent draft' });
      const dialogs = answerDialogs();
      expect(dialogs).toHaveLength(open ? 1 : 0);
      if (open) expect(dialogs[0]).toContain('出力形式を選んでください。');
    });
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it.each([true, false])('closes only the answer dialog on Esc and keeps the stored inquiry pending with options=%s', async (withOptions) => {
    const inquiry = question(withOptions ? {} : { options: undefined });
    const saved = await store.create({ ...goalRecord(), questions: [inquiry] });
    const file = join(cwd, '.takt', 'goals', saved.id, 'goal.json');
    const before = readFileSync(file, 'utf8');
    const { read, answerQuestion } = mount('en');
    await waitFor(() => expect(app!.lastFrame()).toContain('出力形式を選んでください。'));
    await openAnswer();
    app!.stdin.write('\x1b[27u');
    await waitFor(() => {
      expect(prompt()).toMatchObject({ disabled: false, placeholder: 'Discuss your goal' });
      expect(answerDialogs()).toEqual([]);
    });
    const polls = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(polls));
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(await store.get(saved.id)).toEqual(saved);
    expect((await savedEvents.readManagerDisplayEvents(cwd, 'en')).questions).toEqual([
      { goalId: saved.id, repositoryDirectory: cwd, objective: saved.objective, question: saved.questions![0] },
    ]);
    const pending = boxes(app!.lastFrame()!).find((box) => box.includes('出力形式を選んでください。'))!;
    expect(contentRows(pending)[0]).toMatch(/1/u);
    await openAnswer();
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
