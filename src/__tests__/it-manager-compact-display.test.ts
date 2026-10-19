import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
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
import * as savedEvents from '../features/manager/savedEvents.js';
import type { PendingQuestion } from '../features/manager/useManagerQuestionAnswer.js';
import { PromptInput } from '../features/tui/PromptInput.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import type { GoalQuestion } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('../features/tui/PromptInput.js', async (original) => {
  const actual = await original<typeof import('../features/tui/PromptInput.js')>();
  return { ...actual, PromptInput: vi.fn(actual.PromptInput) };
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(PromptInput).mockClear(); });

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
      goalId: goalRecord().id, objective,
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
          expect(row).not.toContain(pending.goalId);
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
    const questions = [{ goalId: goalRecord().id, objective, question: question({ kind: 'question' }) }];
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
    const session: ManagerConversationSession = {
      getAssignment: async () => undefined, getPendingSummary: () => null, resetConversation: () => {},
      dismissSummary: () => {}, handleUserMessage: unused, approveSummary: unused, answerQuestion,
      pauseGoal: unused, resumeGoal: unused, abortGoal: unused, close: async () => {},
    };
    const read = vi.spyOn(savedEvents, 'readManagerDisplayEvents');
    app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: ['会話ログの目印'], onExit: vi.fn() }));
    return { answerQuestion, read };
  }

  const prompt = () => vi.mocked(PromptInput).mock.calls.at(-1)![0];
  const answerDialogs = () => boxes(app!.lastFrame()!).filter((box) => box.includes('本文の末尾')
    && /Free text|Enter your answer|自由記述|回答を入力してください/u.test(box));

  async function openAnswer(): Promise<void> {
    app!.stdin.write(`/answer ${questionId}`);
    await waitFor(() => expect(prompt().text).toBe(`/answer ${questionId}`));
    app!.stdin.write('\r');
    await waitFor(() => {
      expect(prompt().placeholder).toMatch(/Enter your answer|回答を入力してください/u);
      expect(answerDialogs()).toHaveLength(1);
    });
  }

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
      { goalId: saved.id, objective: saved.objective, question: saved.questions![0] },
    ]);
    const pending = boxes(app!.lastFrame()!).find((box) => box.includes('出力形式を選んでください。'))!;
    expect(contentRows(pending)[0]).toMatch(/1/u);
    await openAnswer();
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
