vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});
vi.mock('../infra/goals/events.js', async (original) => ({ ...await original<typeof import('../infra/goals/events.js')>(), saveManagerEvent: vi.fn() }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/tui/PromptInput.js', async (original) => {
  const actual = await original<typeof import('../features/tui/PromptInput.js')>();
  return { ...actual, PromptInput: vi.fn(actual.PromptInput) };
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cleanup,render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { basename,join } from 'node:path';
import { createElement } from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTaskHistory } from '../app/cli/taskHistory.js';
import type { WorkflowState } from '../core/models/index.js';
import * as workflowCore from '../core/workflow/index.js';
import { formatTaskHistorySummary } from '../features/interactive/interactive-summary.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { executeTaskAndCompleteWithDetails,executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { appendGoalNotification,formatGoalQuestionNotification } from '../infra/goals/notifications.js';
import { addGoalQuestion,withdrawGoalQuestion } from '../infra/goals/questions.js';
import type { Goal, GoalQuestion } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { JsonTaskListItem } from '../infra/task/listSerializer.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getLabel } from '../shared/i18n/index.js';
import { goalId,goalRecord } from './helpers/goal-fixtures.js';
import { registerManagerTypedAnswerTests } from './helpers/manager-typed-answers.js';

registerManagerTypedAnswerTests();

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) => args[0] === 'git' ? 'a'.repeat(40) : actual.execFileSync(...args)),
  };
});
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/task/process.js')>()),
  getSelfProcessIdentity: () => ({ startTime: '2026-10-03T14:23:40.1234567Z' }),
  getProcessIdentity: (pid: number) => pid === process.pid
    ? { startTime: '2026-10-03T14:23:40.1234567Z' }
    : undefined,
}));

let cwd: string;
let app: ReturnType<typeof render> | undefined;
let session: ReturnType<typeof createManagerConversationSession> | undefined;

beforeEach(() => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  cwd = realpathSync(mkdtempSync(join(root, 'manager-question-display-')));
  mkdirSync(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt', 'config.yaml'), [
    'provider: mock', 'manager:', '  auto_run: false', '  notifications:', '    question: false',
  ].join('\n'));
  invalidateGlobalConfigCache();
  invalidateResolvedConfigCache(cwd);
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  cleanup();
  try { await session?.close(); }
  finally {
    vi.restoreAllMocks();
    session = undefined;
    invalidateGlobalConfigCache();
    invalidateResolvedConfigCache(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function mountGoalControls(lang: 'ja' | 'en', goal: Goal) {
  const store = new GoalStore(cwd);
  await store.create(goal);
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
    persona: 'manager', status: 'done', timestamp: new Date(),
    content: '', structuredOutput: { message: 'Conversation received', summary: null },
  });
  const provider = new MockProvider();
  vi.spyOn(provider, 'setup').mockReturnValue({ call });
  session = createManagerConversationSession({
    cwd,
    plan: { ctx: { providerType: 'mock', model: undefined, lang, provider },
      strategy: { systemPrompt: 'manager fixture' } },
  });
  app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => expect(app!.lastFrame()!.replace(/\n/gu, '')).toContain(cwd));
  const send = async (text: string): Promise<void> => {
    app!.stdin.write(text);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(text.split('\n')[0]!));
    app!.stdin.write('\r');
  };
  return { store, call, send };
}

function expectGoalMemory(memory: string, goal: Goal): void {
  expect(JSON.parse(memory)).toEqual({
    repositoryCount: 1, truncated: false, retrieval: expect.any(String),
    repositories: [{
      repositoryDirectory: cwd, goalCount: 1, diagnosticCount: 0, diagnostics: [],
      goals: [{
        id: goal.id, objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus,
        branch: goal.branch, integrationBranch: goal.integrationBranch,
        taskCount: 0, taskStates: {}, workUnitCount: 0,
        pendingQuestionCount: 0, questions: [], workLogCount: 0, workLog: [],
        references: { goal: join(cwd, '.takt', 'goals', goal.id, 'goal.json') },
        truncated: true, retrieval: expect.any(String),
      }],
    }],
  });
}

const irreversibleWarning = /取り消せ|元に戻せ|不可逆|cannot.*undo|irreversible/iu;

async function expectAbortConfirmation(goal: Goal): Promise<void> {
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!.replace(/\s+/gu, ' ');
    expect(frame).toContain(goal.objective);
    expect(frame).toMatch(irreversibleWarning);
  });
}

async function selectGoal(goal: Goal, action: 'pause' | 'resume' | 'abort'): Promise<void> {
  await vi.waitFor(() => {
    const lists = app!.lastFrame()?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    expect(lists.some((box) => box.includes(goal.objective) && /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box))).toBe(true);
  });
  app!.stdin.write('\r');
  await selectGoalAction(action);
}

async function selectGoalAction(action: 'pause' | 'resume' | 'abort'): Promise<void> {
  const patterns = { pause: /一時停止|pause/iu, resume: /再開|resume/iu, abort: /中止|abort/iu };
  const rows = (): string[] => {
    const boxes = app!.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    const menu = boxes.find((box) => /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box));
    return menu === undefined ? [] : menu.split('\n').slice(2, -2)
      .filter((row) => Object.values(patterns).some((pattern) => pattern.test(row)));
  };
  await vi.waitFor(() => {
    expect(rows()).toHaveLength(2);
    expect(rows().some((row) => patterns[action].test(row))).toBe(true);
  });
  const index = rows().findIndex((row) => patterns[action].test(row));
  app!.stdin.write('\x1b[A');
  app!.stdin.write('\x1b[A');
  for (let move = 0; move < index; move++) app!.stdin.write('\x1b[B');
  app!.stdin.write('\r');
}

async function openMenu(kind: 'answer' | 'goal'): Promise<void> {
  await vi.waitFor(() => expect(app!.lastFrame()).not.toMatch(/処理中|Working/u));
  app!.stdin.write(kind === 'answer' ? '\x12' : '\x07');
}

function confirmAbort(): void {
  app!.stdin.write('\x1b[A');
  app!.stdin.write('\r');
}

it.each(['choice', 'free text'] as const)('persists only the selected inquiry through the real session with a %s answer', async (mode) => {
  const pending: GoalQuestion = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending',
    body: 'Choose output format', options: mode === 'choice' ? ['CSV', 'JSON'] : undefined };
  const saved: Goal = { ...goalRecord(), objective: 'Shared goal name', questions: [pending] };
  const { store, call } = await mountGoalControls('en', saved);
  const other = await store.create({ ...saved, id: '550e8400-e29b-41d4-a716-446655440001' });
  const candidates = (await readManagerDisplayEvents(cwd, 'en')).questions;
  const selected = candidates[1]!;
  if (selected.goalId === null) throw new Error('Expected a goal inquiry');
  const untouched = await store.get(selected.goalId === saved.id ? other.id : saved.id);
  await openMenu('answer');
  await vi.waitFor(() => {
    const lists = app!.lastFrame()?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    expect(lists.some((box) => box.includes(saved.objective) && /↑|↓/u.test(box) && /Enter/u.test(box))).toBe(true);
  });
  app!.stdin.write('\x1b[B');
  app!.stdin.write('\r');
  await vi.waitFor(() => expect(app!.lastFrame()).toContain(mode === 'choice' ? 'Free text' : 'Enter your answer'));
  expect((await store.get(selected.goalId)).questions![0]!.status).toBe('pending');
  if (mode === 'choice') app!.stdin.write('\x1b[B');
  else app!.stdin.write('Custom output destination');
  app!.stdin.write('\r');
  await vi.waitFor(async () => expect((await store.get(selected.goalId)).questions![0]).toMatchObject({
    status: 'answered', answer: { text: mode === 'choice' ? 'JSON' : 'Custom output destination', source: 'tui' },
  }));
  expect(await store.get(untouched.id)).toEqual(untouched);
  expect(call).not.toHaveBeenCalled();
});

it.each(['multiline', 'wrapped'] as const)('scrolls a %s inquiry and returns to its list without changing the saved record', async (layout) => {
  const start = '本文開始';
  const end = '本文終了';
  const body = layout === 'multiline'
    ? [start, ...Array.from({ length: 30 }, (_, index) => `本文の続き ${index}`), end].join('\n')
    : `${start}${'日本語e\u0301👩‍💻'.repeat(50)}${end}`;
  const pending: GoalQuestion = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body };
  const goal: Goal = { ...goalRecord(), objective: 'Scroll persistence fixture', questions: [pending] };
  const { store, call } = await mountGoalControls('en', goal);
  vi.spyOn(app!.stdout, 'columns', 'get').mockReturnValue(40);
  app!.stdout.emit('resize');
  const answer = vi.spyOn(session!, 'answerQuestion');
  const file = join(cwd, '.takt', 'goals', goal.id, 'goal.json');
  const before = readFileSync(file, 'utf8');
  const saved = await store.get(goal.id);
  const detail = (): string | undefined => app!.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu)
    ?.find((box) => box.includes(getLabel('manager.answerPrompt', 'en')));
  const visibleText = (): string | undefined => detail()?.replace(/[│\s]/gu, '');
  await openMenu('answer');
  await vi.waitFor(() => expect(app!.lastFrame()).toContain(getLabel('manager.selectionHint', 'en')));
  app!.stdin.write('\r');
  await vi.waitFor(() => expect(visibleText()).toContain(start));
  expect(visibleText()).not.toContain(end);
  for (let move = 0; move < 100; move++) app!.stdin.write('\x1b[B');
  await vi.waitFor(() => {
    expect(visibleText()).toContain(end);
    expect(visibleText()).not.toContain(start);
  });
  app!.stdin.write('\x1b[27u');
  await vi.waitFor(() => {
    expect(app!.lastFrame()).toContain(getLabel('manager.selectionTitles.answer', 'en'));
    expect(detail()).toBeUndefined();
  });
  expect(answer).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(await store.get(goal.id)).toEqual(saved);
});

it('updates an open inquiry on terminal resize and uses the new scroll bounds without reopening it', async () => {
  const lines = Array.from({ length: 10 }, (_, index) =>
    `Left${index}`.padEnd(40, 'a') + `Right${index}`.padEnd(40, 'b'));
  const wrapped = lines.flatMap((line) => [line.slice(0, 40), line.slice(40)]);
  const pending: GoalQuestion = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending',
    body: lines.join('\n') };
  const goal: Goal = { ...goalRecord(), objective: 'Resize inquiry fixture', questions: [pending] };
  const { store, call } = await mountGoalControls('en', goal);
  const saved = await store.get(goal.id);
  const columns = vi.spyOn(app!.stdout, 'columns', 'get').mockReturnValue(82);
  app!.stdout.emit('resize');
  const answer = vi.spyOn(session!, 'answerQuestion');
  const bodyRows = (): string[] | undefined => app!.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu)
    ?.find((box) => box.includes(getLabel('manager.answerPrompt', 'en')))
    ?.split('\n').slice(1, -2).map((row) => row.slice(1, -1).trimEnd());
  await openMenu('answer');
  await vi.waitFor(() => expect(app!.lastFrame()).toContain(getLabel('manager.selectionHint', 'en')));
  app!.stdin.write('\r');
  await vi.waitFor(() => expect(bodyRows()).toEqual(lines.slice(0, 8)));
  for (let move = 0; move < 20; move++) app!.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(bodyRows()).toEqual(lines.slice(2)));

  columns.mockReturnValue(42);
  app!.stdout.emit('resize');
  await vi.waitFor(() => expect(bodyRows()).toEqual(wrapped.slice(2, 10)));
  for (let move = 0; move < 20; move++) app!.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(bodyRows()).toEqual(wrapped.slice(12)));
  app!.stdin.write('\x1b[B');
  app!.stdin.write('\x1b[A');
  await vi.waitFor(() => expect(bodyRows()).toEqual(wrapped.slice(11, 19)));
  app!.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(bodyRows()).toEqual(wrapped.slice(12)));

  columns.mockReturnValue(82);
  app!.stdout.emit('resize');
  await vi.waitFor(() => expect(bodyRows()).toEqual(lines.slice(2)));
  app!.stdin.write('\x1b[A');
  await vi.waitFor(() => expect(bodyRows()).toEqual(lines.slice(1, 9)));
  app!.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(bodyRows()).toEqual(lines.slice(2)));
  expect(await store.get(goal.id)).toEqual(saved);
  expect(answer).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
});

it.each(['enter', 'escape'] as const)('blocks inquiry entry during registration then handles a real answer with %s', async (confirm) => {
  const question: GoalQuestion = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: 'Choose output format' };
  const goal = { ...goalRecord(), questions: [question] };
  const { store, call, send } = await mountGoalControls('en', goal);
  const beforeAnswer = await store.get(goal.id);
  const summary = { objective: 'Export data', outOfScope: [], acceptanceCriteria: ['Output saved'], constraints: [] };
  call.mockResolvedValueOnce({ persona: 'manager', status: 'done', timestamp: new Date(), content: '',
    structuredOutput: { message: 'Summary ready', summary } });
  await send('Prepare export');
  await vi.waitFor(() => expect(app!.lastFrame()).toContain('Summary to register'));
  let finish!: () => void;
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  const approval = vi.spyOn(session!, 'approveSummary').mockImplementation(async (revision) => {
    await registration;
    session!.dismissSummary(revision);
    return { kind: 'reply', message: 'Registration finished' };
  });
  const answer = vi.spyOn(session!, 'answerQuestion');
  try {
    app!.stdin.write('\x0f');
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    app!.stdin.write('会話の下書き');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('会話の下書き'));
    app!.stdin.write('\x12');
    app!.stdin.write('保持');
    await vi.waitFor(() => {
      expect(app!.lastFrame()).toContain('会話の下書き保持');
      expect(app!.lastFrame()).not.toContain('Enter your answer');
      expect(app!.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'en'));
    });
    expect(answer).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('Working'));
    await openMenu('answer');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(getLabel('manager.selectionHint', 'en')));
    app!.stdin.write('\r');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('Enter your answer'));
    app!.stdin.write('CSVで保存');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('CSVで保存'));
    app!.stdin.write(confirm === 'enter' ? '\r' : '\x1b[27u');
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('Enter your answer'));
    const saved = await store.get(goal.id);
    if (confirm === 'enter') {
      await vi.waitFor(async () => expect((await store.get(goal.id)).questions![0]).toMatchObject({
        status: 'answered', answer: { text: 'CSVで保存', source: 'tui' },
      }));
      expect(answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ goalId: goal.id, questionId: question.id, answer: { text: 'CSVで保存' } }));
    } else {
      expect(saved.questions).toEqual(beforeAnswer.questions);
      expect(answer).not.toHaveBeenCalled();
    }
    expect(call.mock.calls.map(([text]) => text)).not.toContain('CSVで保存');
    expect(call).toHaveBeenCalledOnce();
    expect(app!.lastFrame()).toContain('会話の下書き保持');
  } finally { finish(); }
});

it.each(['pause', 'resume', 'abort'] as const)('filters mixed saved goal states and applies %s only to the second selected goal', async (command) => {
  const executionStatus = command === 'resume' ? 'paused' : 'active';
  const saved: Goal = { ...goalRecord(), objective: 'Eligible first', executionStatus };
  const { store, call } = await mountGoalControls('en', saved);
  const other = await store.create({ ...saved, id: '550e8400-e29b-41d4-a716-446655440001', objective: 'Eligible second' });
  await store.create({ ...saved, id: '550e8400-e29b-41d4-a716-446655440002', objective: 'Completed candidate', status: 'completed',
    completion: { goalBranch: saved.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      summary: 'Completed', instructions: ['Verified merge'],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } } });
  await store.create({ ...saved, id: '550e8400-e29b-41d4-a716-446655440003', objective: 'Aborted candidate', executionStatus: 'aborted' });
  await openMenu('goal');
  await vi.waitFor(() => {
    const lists = app!.lastFrame()?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    const list = lists.find((box) => /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box));
    expect(list).toBeDefined();
    expect(list).toContain(saved.objective);
    expect(list).toContain(other.objective);
    expect(list).not.toContain('Completed candidate');
    expect(list).not.toContain('Aborted candidate');
  });
  app!.stdin.write('\x1b[B');
  app!.stdin.write('\r');
  await selectGoalAction(command);
  if (command === 'abort') { await expectAbortConfirmation(other); confirmAbort(); }
  const expected = command === 'pause' ? 'paused' : command === 'resume' ? 'active' : 'aborted';
  await vi.waitFor(async () => expect((await store.get(other.id)).executionStatus).toBe(expected));
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
});

it.each([
  { lang: 'ja' as const, executionStatus: 'active' as const },
  { lang: 'en' as const, executionStatus: 'active' as const },
  { lang: 'ja' as const, executionStatus: 'paused' as const },
  { lang: 'en' as const, executionStatus: 'paused' as const },
])('rejects abort of a completed $executionStatus goal in the session and before confirmation in the $lang TUI', async ({ lang, executionStatus }) => {
  const saved: Goal = {
    ...goalRecord(), status: 'completed', executionStatus,
    completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      summary: 'Completion evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      instructions: ['git merge reviewed SHA'],
    },
  };
  const { store, call } = await mountGoalControls(lang, saved);
  const abort = vi.spyOn(session!, 'abortGoal');
  const runner = new TaskRunner(cwd);
  runner.addTask('preserve pending work', { goal_id: saved.id });
  const before = new TaskStore(cwd).read();
  expect(await session!.abortGoal({ goalId: saved.id })).toMatchObject({
    kind: 'error', message: expect.stringMatching(/completed/iu),
  });
  expect(await store.get(saved.id)).toEqual(saved);
  expect(new TaskStore(cwd).read()).toEqual(before);
  abort.mockClear();
  await openMenu('goal');
  await vi.waitFor(() => {
    expect(app!.lastFrame()).toMatch(lang === 'ja' ? /(?:対象|ゴール).*(?:ありません|なし)/u : /no.*(?:goals|targets)/iu);
    expect(app!.lastFrame()).not.toMatch(irreversibleWarning);
  });
  expect(abort).not.toHaveBeenCalled();
  expect(await store.get(saved.id)).toEqual(saved);
  expect(new TaskStore(cwd).read()).toEqual(before);
  expect(call).not.toHaveBeenCalled();
});

it.each([
  { lang: 'ja' as const, executionStatus: 'active' as const },
  { lang: 'en' as const, executionStatus: 'active' as const },
  { lang: 'ja' as const, executionStatus: 'paused' as const },
  { lang: 'en' as const, executionStatus: 'paused' as const },
])('aborts a $executionStatus goal only after human confirmation and refreshes the same $lang TUI', async ({ lang, executionStatus }) => {
  const saved: Goal = { ...goalRecord(), executionStatus, objective: 'Abort target',
  };
  const { store, call } = await mountGoalControls(lang, saved);
  await openMenu('goal');
  await selectGoal(saved, 'abort');
  await expectAbortConfirmation(saved);
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
  confirmAbort();
  await vi.waitFor(async () => expect((await store.get(saved.id)).executionStatus).toBe('aborted'));
  expect(await store.get(saved.id)).toEqual({ ...saved, executionStatus: 'aborted' });
  const expectAbortedGoal = (): void => {
    expect(app!.lastFrame()!.split('\n').find((row) => /\^R/u.test(row))).toMatch(lang === 'ja'
      ? /進行中\s*0/u : /(?:in progress|ongoing|active)\s*:?\s*0/iu);
  };
  await vi.waitFor(expectAbortedGoal);
  expect(call).not.toHaveBeenCalled();
  await openMenu('goal');
  await vi.waitFor(() => expect(app!.lastFrame()).toMatch(/(?:対象|ゴール).*(?:ありません|なし)|no.*(?:goals|targets)/iu));
  expect((await store.get(saved.id)).executionStatus).toBe('aborted');
  app!.unmount();
  app = render(createElement(ManagerView, { cwd, lang, session: session!, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(expectAbortedGoal);
});

it.each(['default', 'escape'] as const)('cancels abort with %s without changing saved state or calling the agent', async (choice) => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store, call, send } = await mountGoalControls('ja', saved);
  await openMenu('goal');
  await selectGoal(saved, 'abort');
  await expectAbortConfirmation(saved);
  app!.stdin.write(choice === 'default' ? '\r' : '\x1b[27u');
  await vi.waitFor(() => expect(app!.lastFrame()!.replace(/\s+/gu, ' ')).not.toMatch(irreversibleWarning));
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
  await send('Continue conversation');
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(await store.get(saved.id)).toEqual(saved);
});

it.each([
  `操作例: /abort ${goalId}`, `> /abort ${goalId}`, `/aborted ${goalId}`,
  `\`\`\`text\n/abort ${goalId}\n\`\`\``, `~~~text\n> /abort ${goalId}\n~~~`,
  `\`\`\`text\n> ~~~\n/abort ${goalId}\n~~~\n\`\`\``, `\`\`\`\n/abort ${goalId}`,
  `説明\n/abort ${goalId}`,
])('keeps abort examples as conversation text without opening confirmation: %s', async (text) => {
  const saved = goalRecord();
  const { store, call, send } = await mountGoalControls('ja', saved);
  await send(text);
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  const [conversation, memory] = call.mock.calls[0]![0].split('\n\nGoal memory (including run manager results): ');
  expect(conversation).toBe(text);
  expectGoalMemory(memory!, saved);
  expect(await store.get(saved.id)).toEqual(saved);
  expect(app!.lastFrame()!.replace(/\s+/gu, ' ')).not.toMatch(irreversibleWarning);
});

it('invalidates only pending work belonging to the confirmed goal and preserves running and terminal records', async () => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store } = await mountGoalControls('en', saved);
  const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
  const runner = new TaskRunner(cwd);
  const running = runner.addTask('in-flight work', { goal_id: saved.id });
  expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([running.name]);
  const pending = runner.addTask('cancel this work', { goal_id: saved.id });
  const ordinary = runner.addTask('ordinary work');
  const unrelated = runner.addTask('other goal work', { goal_id: other.id });
  const completed = runner.addTask('completed work', { goal_id: saved.id });
  runner.completeTask({ task: completed, success: true, startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z', response: 'done', executionLog: [], prUrl: 'https://example.com/pull/7', branch: 'task/completed-work' });
  const failed = runner.addTask('failed work', { goal_id: saved.id });
  runner.failTask({ task: failed, success: false, startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z', response: 'Execution failed', executionLog: [] });
  const before = runner.listTaskStateItems();
  const beforeRecords = new TaskStore(cwd).read().tasks;
  await openMenu('goal');
  await selectGoal(saved, 'abort');
  await expectAbortConfirmation(saved);
  expect(runner.listTaskStateItems()).toEqual(before);
  confirmAbort();
  await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === pending.name)).toMatchObject({ status: 'failed' }));
  const reader = new TaskRunner(cwd);
  const after = reader.listTaskStateItems();
  expect(after).toHaveLength(before.length);
  const invalidated = after.find(({ name }) => name === pending.name)!;
  expect(invalidated).toMatchObject({ goalId: saved.id, status: 'failed', failure: { error: expect.stringMatching(/goal.*abort|ゴール.*中止/iu), retryable: false } });
  expect(invalidated.startedAt).toBeUndefined();
  expect(invalidated.completedAt).toBeUndefined();
  const restored = new TaskStore(cwd).read().tasks;
  const expectedInvalidation = { ...beforeRecords.find(({ name }) => name === pending.name)!, status: 'failed', started_at: null, completed_at: null,
    failure: invalidated.failure };
  expect(restored).toContainEqual(expect.objectContaining(expectedInvalidation));
  expect(parseYaml(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8'))).toMatchObject({
    tasks: expect.arrayContaining([expect.objectContaining(expectedInvalidation)]),
  });
  for (const task of [running, ordinary, unrelated, completed, failed]) {
    expect(after.find(({ name }) => name === task.name)).toEqual(before.find(({ name }) => name === task.name));
    expect(restored.find(({ name }) => name === task.name)).toEqual(beforeRecords.find(({ name }) => name === task.name));
  }
  for (const lang of ['ja', 'en'] as const) {
    const history = loadTaskHistory(cwd, lang);
    const cancelledHistory = history.find(({ worktreeId }) => worktreeId === pending.name)!;
    expect(cancelledHistory).toMatchObject({ status: 'failed', startedAt: 'N/A', completedAt: 'N/A', failureSummary: invalidated.failure!.error });
    expect(formatTaskHistorySummary([cancelledHistory], lang)).toContain('N/A / N/A');
    for (const task of [completed, failed]) {
      const executedHistory = history.find(({ worktreeId }) => worktreeId === task.name)!;
      expect(executedHistory).toMatchObject({ startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z' });
      expect(formatTaskHistorySummary([executedHistory], lang)).toContain('2026-10-10T00:00:00Z / 2026-10-10T00:01:00Z');
    }
  }
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await listTasksNonInteractive(cwd, { enabled: true, format: 'json' });
  expect(output).toHaveBeenCalledOnce();
  const json = JSON.parse(output.mock.calls[0]![0] as string) as { tasks: JsonTaskListItem[] };
  output.mockRestore();
  expect(json.tasks).toHaveLength(before.length);
  const cancelledJson = json.tasks.find(({ name }) => name === pending.name)!;
  expect(cancelledJson).toMatchObject({ kind: 'failed', failure: { error: invalidated.failure!.error } });
  expect(cancelledJson).not.toHaveProperty('startedAt');
  expect(cancelledJson).not.toHaveProperty('completedAt');
  for (const task of [completed, failed]) {
    expect(json.tasks.find(({ name }) => name === task.name)).toMatchObject({ startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z' });
  }
  expect(runner.claimNextTasks(3).map(({ name }) => name)).toEqual([ordinary.name, unrelated.name]);
  expect(runner.claimNextTasks(1)).toEqual([]);
  expect(await store.get(saved.id)).toEqual({ ...saved, executionStatus: 'aborted' });
});

it.each(['retry', 'cancel', 'escape'] as const)('handles failed pending invalidation through TUI %s without reopening the aborted goal', async (action) => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store, call } = await mountGoalControls('en', saved);
  const runner = new TaskRunner(cwd);
  const pending = runner.addTask('pending abort retry', { goal_id: saved.id });
  await openMenu('goal');
  await selectGoal(saved, 'abort');
  await expectAbortConfirmation(saved);
  const abort = vi.spyOn(session!, 'abortGoal');
  const failUpdate = (): never => { throw new Error('Pending write unavailable'); };
  const update = vi.spyOn(TaskStore.prototype, 'update').mockImplementationOnce(failUpdate);
  confirmAbort();
  await vi.waitFor(async () => expect((await store.get(saved.id)).executionStatus).toBe('aborted'));
  await vi.waitFor(() => expect(app!.lastFrame()).toContain('Pending write unavailable'));
  await vi.waitFor(() => {
    expect(app!.lastFrame()).toContain(getLabel('manager.retryAbort', 'en'));
    expect(app!.lastFrame()).not.toContain('Working');
  });
  update.mockRestore();
  expect(new TaskStore(cwd).read().tasks).toContainEqual(expect.objectContaining({ name: pending.name, status: 'pending', started_at: null, completed_at: null }));
  expect(runner.claimNextTasks(1)).toEqual([]);
  if (action !== 'retry') {
    app!.stdin.write(action === 'cancel' ? '\r' : '\x1b[27u');
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain(getLabel('manager.retryAbort', 'en')));
    expect(abort).toHaveBeenCalledOnce();
    expect((await store.get(saved.id)).executionStatus).toBe('aborted');
    expect(new TaskStore(cwd).read().tasks.find(({ name }) => name === pending.name)?.status).toBe('pending');
    expect(call).not.toHaveBeenCalled();
    return;
  }
  const errorCount = app!.lastFrame()?.match(/Pending write unavailable/gu)?.length ?? 0;
  const retryUpdate = vi.spyOn(TaskStore.prototype, 'update').mockImplementationOnce(failUpdate);
  confirmAbort();
  await vi.waitFor(() => {
    expect(abort).toHaveBeenCalledTimes(2);
    expect(retryUpdate).toHaveBeenCalledOnce();
    expect(app!.lastFrame()?.match(/Pending write unavailable/gu)?.length).toBeGreaterThan(errorCount);
    expect(app!.lastFrame()).toContain(getLabel('manager.retryAbort', 'en'));
    expect(app!.lastFrame()).not.toContain('Working');
  });
  retryUpdate.mockRestore();
  expect(new TaskStore(cwd).read().tasks.find(({ name }) => name === pending.name)?.status).toBe('pending');
  confirmAbort();
  await vi.waitFor(() => expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: pending.name, status: 'failed', failure: expect.objectContaining({ retryable: false }) })));
  expect(new TaskStore(cwd).read().tasks).toContainEqual(expect.objectContaining({ name: pending.name, status: 'failed', started_at: null, completed_at: null, failure: expect.objectContaining({ retryable: false }) }));
  expect(runner.claimNextTasks(1)).toEqual([]);
  expect((await store.get(saved.id)).executionStatus).toBe('aborted');
  await vi.waitFor(() => expect(app!.lastFrame()).not.toContain(getLabel('manager.retryAbort', 'en')));
  expect(abort.mock.calls.map(([options]) => options.goalId)).toEqual([saved.id, saved.id, saved.id]);
  expect(call).not.toHaveBeenCalled();
});

it('exposes manager work tools without exposing a goal abort tool to the agent', async () => {
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
  const client = new Client({ name: 'manager-abort-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain('takt_enqueue_goal_task');
    expect(names.filter((name) => /abort/iu.test(name))).toEqual([]);
  } finally { await client.close(); await server.close(); }
});

it('keeps SIGINT ownership when a single goal task receives its own signal without a worker pool', async () => {
  const goal = await new GoalStore(cwd).create(goalRecord());
  mkdirSync(join(cwd, '.takt', 'workflows'));
  writeFileSync(join(cwd, '.takt', 'workflows', 'single-goal.yaml'), 'name: single-goal\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  const engine = new EventEmitter();
  let finish!: (state: Partial<WorkflowState>) => void;
  const work = new Promise<Partial<WorkflowState>>((resolve) => { finish = resolve; });
  let interrupted = false;
  const abort = (): void => {
    if (interrupted) return;
    interrupted = true;
    const state = { status: 'aborted' as const, iteration: 1 };
    engine.emit('workflow:abort', state, 'user_interrupted', 'interrupt', {
      kind: 'interrupt', step: 'work', reason: 'user_interrupted', error: 'user_interrupted',
    });
    finish(state);
  };
  let providerSignal: AbortSignal | undefined;
  vi.spyOn(workflowCore, 'WorkflowEngine').mockImplementation(function (_config, _cwd, _task, options) {
    providerSignal = options?.abortSignal;
    return Object.assign(engine, { run: async () => work, abort, isAbortRequested: () => interrupted }) as never;
  });
  const runner = new TaskRunner(cwd);
  runner.addTask('single goal work', { workflow: 'single-goal', goal_id: goal.id, worktree: false });
  const task = runner.claimNextTasks(1)[0]!;
  const listeners = new Set(process.listeners('SIGINT'));
  let taskSignal: AbortSignal | undefined;
  const execution = executeTaskAndCompleteWithDetails(task, runner, cwd, (options) => {
    taskSignal = options.abortSignal;
    return executeTaskWithResult(options);
  });
  try {
    let listener: NodeJS.SignalsListener | undefined;
    await vi.waitFor(() => {
      listener = process.listeners('SIGINT').find((value) => !listeners.has(value));
      expect(listener).toBeDefined();
      expect(providerSignal).toBeDefined();
    }, { timeout: 2000 });
    expect(taskSignal).toBeDefined();
    expect(taskSignal!.aborted).toBe(false);
    listener!('SIGINT');
    expect(providerSignal!.aborted).toBe(true);
    expect((await execution).success).toBe(false);
    expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: task.name, status: 'failed', completion: expect.objectContaining({ success: false, interrupted: true }) }));
    expect(process.listeners('SIGINT').filter((value) => !listeners.has(value))).toEqual([]);
  } finally { abort(); await execution; }
});

it.each(['ja', 'en'] as const)('pauses and resumes an awaiting-merge goal from commands in the same %s TUI while preserving evidence', async (lang) => {
  const saved: Goal = { ...goalRecord(), objective: 'Goal display fixture', status: 'awaiting_merge',
    completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready for integration',
      changeSummary: { filesChanged: 1, additions: 2, deletions: 0,
        files: [{ path: 'result.txt', additions: 2, deletions: 0 }], truncated: false, totalsTruncated: false },
      instructions: ['git merge --ff-only goal-branch'],
    },
  };
  const { store, call } = await mountGoalControls(lang, saved);
  await openMenu('goal');
  await selectGoal(saved, 'pause');
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('paused'));
  expect(await store.get(goalId)).toEqual({ ...saved, executionStatus: 'paused' });
  await openMenu('goal');
  await vi.waitFor(() => {
    const boxes = app!.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    const list = boxes.find((box) => /↑|↓/u.test(box) && /Enter/u.test(box));
    expect(list).toContain(saved.objective);
    expect(list).toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
  });
  expect(call).not.toHaveBeenCalled();
  await selectGoal(saved, 'resume');
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('active'));
  expect(await store.get(goalId)).toEqual(saved);
  await openMenu('goal');
  await vi.waitFor(() => {
    const boxes = app!.lastFrame()!.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu) ?? [];
    const list = boxes.find((box) => /↑|↓/u.test(box) && /Enter/u.test(box));
    expect(list).toContain(saved.objective);
    expect(list).toContain(getLabel('manager.goalStates.active', lang));
  });
  expect(call).not.toHaveBeenCalled();
});

it.each([
  '操作例: /pause', '> /pause', '```\n/pause', '~~~\n/pause',
  '```\n/pause GOAL\n```', '~~~\n/pause GOAL\n~~~', '/paused',
  '説明\n/pause',
])('keeps command-like conversation text as ordinary input: %s', async (prefix) => {
  const saved = goalRecord();
  const { store, call, send } = await mountGoalControls('ja', saved);
  const text = prefix.includes('GOAL') ? prefix.replace('GOAL', goalId) : `${prefix} ${goalId}`;
  await send(text);
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  const [conversation, memory] = call.mock.calls[0]![0].split('\n\nGoal memory (including run manager results): ');
  expect(conversation).toBe(text);
  expectGoalMemory(memory!, saved);
  expect(await store.get(goalId)).toEqual(saved);
});

it('shows compact pending questions and an ID-free answer hint when notifications are disabled, excluding withdrawn questions on reopening', async () => {
  const input = { body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV' };
  const added = addGoalQuestion(goalRecord(), input);
  const remaining = addGoalQuestion(added.goal, { body: '保存先はどこですか' });
  const policy = resolveManagerConfig(cwd).notifications;
  expect(policy.question).toBe(false);
  const store = new GoalStore(cwd);
  await store.create(appendGoalNotification(remaining.goal, { kind: 'question', body: input.body }, policy));
  const saved = await store.get(goalId);
  expect(saved.notifications ?? []).toEqual([]);
  expect(saved.questions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: added.questionId, ...input, status: 'pending' }),
  ]));
  session = createManagerConversationSession({
    cwd,
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture' },
    },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
  await openMenu('answer');
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    const rows = frame.split('\n');
    expect(rows.find((row) => row.includes(input.body))).toContain(saved.objective);
    expect(rows.find((row) => row.includes(input.body))).toContain('質問');
    expect(frame).toContain('保存先はどこですか');
    expect(frame).toContain('^R');
    for (const row of rows) {
      for (const id of [goalId, added.questionId, remaining.questionId]) expect(row).not.toContain(id);
      for (const option of input.options) expect(row).not.toContain(option);
    }
  });
  app.unmount();
  await store.update(goalId, (goal) => withdrawGoalQuestion(goal, added.questionId));
  const display = await readManagerDisplayEvents(cwd);
  expect(display.events).toEqual([]);
  expect(display.diagnostics).toEqual([]);
  expect(display.questions.map(({ question }) => question.id)).toEqual([remaining.questionId]);
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
  await openMenu('answer');
  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain('保存先はどこですか');
    expect(frame).toContain('^R');
    expect(frame).not.toContain(added.questionId);
    expect(frame).not.toContain(input.body);
  });
});

it.each(['startup', 'polling'] as const)('hides default question notifications on %s while preserving details, records and custom notifications', async (phase) => {
  const childProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  childProcess.execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  invalidateResolvedConfigCache(cwd);
  expect(resolveManagerConfig(cwd).notifications.question).toBe(true);
  const { store, call } = await mountGoalControls('ja', goalRecord());
  await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('処理中'));
  if (phase === 'startup') app!.unmount();
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
  const client = new Client({ name: 'manager-question-display-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { body: '出力形式を選んでください', options: ['CSV', 'JSON'], recommendation: 'CSVを推奨します' };
    const result = await client.callTool({ name: 'takt_ask_goal_question', arguments: { cwd, goalId, ...input } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const saved = await store.get(goalId);
    expect(saved.questions![0]).toMatchObject(input);
    expect(saved.notifications).toEqual([expect.objectContaining({ kind: 'question' })]);
    const display = await readManagerDisplayEvents(cwd, 'ja');
    expect(display.questions).toHaveLength(1);
    expect(display.events).toEqual([]);
    if (phase === 'startup') app = render(createElement(ManagerView, { cwd, lang: 'ja', session: session!, initialDiagnostics: [], onExit: vi.fn() }));
    await vi.waitFor(() => expect(app!.lastFrame()).toContain('未回答 1'));
    const transcript = (): string => app!.lastFrame()!.split(/進行中\s+\d/u)[0]!;
    for (const value of [input.body, ...input.options, input.recommendation]) expect(transcript()).not.toContain(value);
    await openMenu('answer');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(getLabel('manager.selectionHint', 'ja')));
    app!.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain(getLabel('manager.selectionHint', 'ja')));
    for (const value of [input.body, ...input.options, input.recommendation]) expect(transcript()).not.toContain(value);
    await openMenu('answer');
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(getLabel('manager.selectionHint', 'ja')));
    app!.stdin.write('\r');
    await vi.waitFor(() => {
      for (const value of [input.body, ...input.options, input.recommendation]) expect(app!.lastFrame()).toContain(value);
    });
    expect(await store.get(goalId)).toEqual(saved);
    app!.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app!.lastFrame()).not.toContain('回答を入力してください'));
    // 同じ本文でも種別が custom の通知は従来どおり表示する。
    const custom = { ...saved, notifications: saved.notifications!.map((notification) => ({ ...notification, kind: 'custom' as const })) };
    await store.update(goalId, () => custom);
    const customDisplay = await readManagerDisplayEvents(cwd, 'ja');
    expect(customDisplay.events).toHaveLength(1);
    for (const value of [input.body, ...input.options, input.recommendation]) expect(customDisplay.events[0]!.message).toContain(value);
    await vi.waitFor(() => {
      for (const value of [input.body, ...input.options, input.recommendation]) expect(transcript()).toContain(value);
    });
    expect(await store.get(goalId)).toEqual(custom);
    expect(call).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});

it.each([true, false])('keeps human inquiries and custom notifications without projecting question notices into the TUI (notifications=%s)', async (enabled) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    question: ${enabled}\n`);
  invalidateResolvedConfigCache(cwd);
  const human = addGoalQuestion(goalRecord(), { recipient: 'human', body: '出力形式はどれですか' });
  const second = addGoalQuestion(human.goal, { body: '出力先はどこですか' });
  const questions = second.goal.questions!;
  const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
  let saved = second.goal;
  for (const question of questions) saved = appendGoalNotification(saved, { kind: 'question', body: formatGoalQuestionNotification(question, 'ja') }, policy);
  saved = appendGoalNotification(saved, { kind: 'custom', body: `${second.questionId}: 一般通知` }, policy);
  saved = appendGoalNotification(saved, { kind: 'question', body: `関連質問 ${second.questionId}: 本文中のID` }, policy);
  await new GoalStore(cwd).create(saved);
  const display = await readManagerDisplayEvents(cwd);
  expect(display.questions.map(({ question }) => question.id).sort()).toEqual([human.questionId, second.questionId].sort());
  expect(display.events.map(({ id }) => JSON.parse(id)[2])).toEqual(saved.notifications!.filter(({ kind }) => kind !== 'question').map(({ id }) => id));
  session = createManagerConversationSession({
    cwd,
    plan: { ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture' } },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
  await openMenu('answer');
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    expect(frame).toContain('出力形式はどれですか');
    expect(frame).toContain('出力先はどこですか');
    const guidance = frame.split('\n').filter((row) => /\^R|Ctrl\+R/u.test(row));
    expect(guidance.length).toBeGreaterThan(0);
    for (const row of guidance) {
      expect(row).not.toContain(human.questionId);
      expect(row).not.toContain(second.questionId);
    }
    expect(frame).toContain(`${second.questionId}: 一般通知`);
  });
});

it.each(['ja', 'en'] as const)('renders saved notification text in the %s TUI language with the project name and short goal reference', async (lang) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nlanguage: ${lang === 'ja' ? 'en' : 'ja'}\nmanager:\n  auto_run: false\n`);
  invalidateResolvedConfigCache(cwd);
  const saved: Goal = { ...goalRecord(), objective: 'Customer export checks', notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440001', kind: 'completed', body: 'Acceptance checks passed',
    recordedAt: '2026-10-08T00:00:00Z',
  }] };
  const { store, call } = await mountGoalControls(lang, saved);
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    const rows = frame.split('\n');
    const heading = rows.find((row) => (lang === 'ja' ? /ゴールが完成|ゴールが完了/u : /goal completed|goal is complete/iu).test(row));
    expect(heading).toContain(basename(cwd));
    expect(frame).toContain(saved.objective);
    expect(frame).toContain(saved.id.slice(0, 8));
    expect(frame).toContain('Acceptance checks passed');
    expect(frame).not.toContain(saved.id);
    expect(rows.filter((row) => /^\s*completed\s*$/iu.test(row))).toEqual([]);
  });
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
});

it.each([
  { lang: 'ja' as const, kind: 'blocked' as const }, { lang: 'en' as const, kind: 'blocked' as const },
  { lang: 'ja' as const, kind: 'custom' as const }, { lang: 'en' as const, kind: 'custom' as const },
])('renders the complete long $kind body from saved events in the $lang TUI', async ({ lang, kind }) => {
  const reason = lang === 'ja' ? '認証に失敗しました。' : 'Authentication failed.';
  const action = lang === 'ja' ? '検証用の認証情報を更新してください。' : 'Update test credentials.';
  const details = Array.from({ length: 20 }, (_, index) => `Detail ${index}: ${'x'.repeat(40)}.`).join('\n');
  const body = `${reason}\ne\u0301\n${details}\n${action}  `;
  const saved: Goal = { ...goalRecord(), objective: 'Customer export checks', notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440001', kind, body, recordedAt: '2026-10-08T00:00:00Z',
  }] };
  const { store, call } = await mountGoalControls(lang, saved);
  const display = await readManagerDisplayEvents(cwd, lang);
  expect(display.diagnostics).toEqual([]);
  expect(display.events).toHaveLength(1);
  expect(display.events[0]!.id).toBe(JSON.stringify([saved.id, 'notification', saved.notifications![0]!.id]));
  expect.soft(display.events[0]!.message.split('\n').slice(2, 2 + body.split('\n').length).join('\n')).toBe(body);
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    expect(frame.normalize('NFC').replace(/\s+/gu, '')).toContain(body.normalize('NFC').replace(/\s+/gu, ''));
    expect(frame).toMatch(lang === 'ja' ? (kind === 'blocked' ? /進められません/u : /お知らせ/u)
      : (kind === 'blocked' ? /cannot proceed/iu : /notification/iu));
    expect(frame).toContain(saved.id.slice(0, 8));
  });
});

it.each([
  { lang: 'ja' as const, severity: 'warning' as const }, { lang: 'en' as const, severity: 'warning' as const },
  { lang: 'ja' as const, severity: undefined }, { lang: 'en' as const, severity: undefined },
])('renders only specified notification severity in the $lang TUI (severity=$severity)', async ({ lang, severity }) => {
  const saved: Goal = { ...goalRecord(), notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440001', kind: 'custom', body: 'warning',
    ...(severity === undefined ? {} : { severity }), recordedAt: '2026-10-08T00:00:00Z',
  }] };
  const { store, call } = await mountGoalControls(lang, saved);
  const prefix = lang === 'ja' ? '重要度: ' : 'Severity: ';
  const expected = prefix + (lang === 'ja' ? '警告' : 'Warning');
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    expect(frame).toContain('warning');
    const rows = frame.split('\n').filter((row) => row.includes(prefix));
    if (severity === undefined) expect(rows).toEqual([]);
    else {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(expected);
    }
  });
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('renders old saved merge instructions once in the %s TUI without migrating the record', async (lang) => {
  const goalSha = 'a'.repeat(40);
  const summary = 'Acceptance checks passed';
  const commands = ['git status --short', "git switch 'release'", `git merge --no-ff --no-edit '${goalSha}'`];
  const instructions = ['Run in a clean worktree of this repository where switching branches is possible.', ...commands];
  const body = `${summary}\nrelease: ${goalSha}\n${instructions.join('\n')}`;
  expect(body.length).toBeLessThan(600);
  const saved: Goal = { ...goalRecord(), status: 'awaiting_merge', completion: {
    goalBranch: goalRecord().branch, goalSha, targetBranch: 'release', summary, instructions,
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  }, notifications: [{ id: '650e8400-e29b-41d4-a716-446655440001', kind: 'awaiting_merge', body,
    recordedAt: '2026-10-08T00:00:00Z' }] };
  const { store, call } = await mountGoalControls(lang, saved);
  const display = await readManagerDisplayEvents(cwd, lang);
  expect(display.diagnostics).toEqual([]);
  expect(display.events).toHaveLength(1);
  expect(display.events[0]!.message.split('\n').filter((line) => line.startsWith('git'))).toEqual(commands);
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    expect(frame).toContain(summary);
    expect(frame).toMatch(lang === 'ja' ? /release ブランチへマージ/u : /merge them into the release branch/iu);
    const normalized = frame.replace(/\s+/gu, '');
    let previous = -1;
    for (const command of commands) {
      const token = command.replace(/\s+/gu, '');
      const position = normalized.indexOf(token);
      expect(position).toBeGreaterThan(previous);
      expect(normalized.indexOf(token, position + token.length)).toBe(-1);
      previous = position;
    }
    expect(frame).not.toContain(`release: ${goalSha}`);
  });
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('reopens the %s TUI without withdrawn question details while retaining saved notification history', async (lang) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    question: true\n');
  invalidateResolvedConfigCache(cwd);
  const question = { id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human' as const, status: 'pending' as const,
    body: 'Which output format?', options: ['CSV', 'JSON', 'TSV', 'XML', 'YAML', 'Parquet'], recommendation: 'CSV' };
  const saved: Goal = { ...goalRecord(), questions: [question], notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440002', kind: 'question',
    body: formatGoalQuestionNotification(question, lang === 'ja' ? 'en' : 'ja'), recordedAt: '2026-10-08T00:00:00Z',
  }] };
  const { store, call } = await mountGoalControls(lang, saved);
  await vi.waitFor(() => expect(app!.lastFrame()).toContain('^R'));
  app!.unmount();
  const withdrawn = await store.update(saved.id, (goal) => withdrawGoalQuestion(goal, question.id));
  expect(withdrawn.questions).toEqual([{
    ...question, kind: 'question', status: 'withdrawn', withdrawnAt: expect.any(String),
  }]);
  expect(withdrawn.notifications).toEqual(saved.notifications);
  const display = await readManagerDisplayEvents(cwd, lang);
  expect(display.questions).toEqual([]);
  expect(display.events).toEqual([]);
  app = render(createElement(ManagerView, { cwd, lang, session: session!, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!;
    expect(frame).toContain(lang === 'ja' ? '未回答 0' : 'Pending 0');
    for (const value of [question.body, ...question.options]) expect(frame).not.toContain(value);
    expect(frame).not.toContain(question.id);
  });
  expect(await store.get(saved.id)).toEqual(withdrawn);
  expect(call).not.toHaveBeenCalled();
});

it.each(['question', 'awaiting_merge', 'completed', 'progress', 'blocked', 'custom'] as const)(
  'applies the current %s switch to saved TUI notifications without hiding questions or work records', async (kind) => {
    const question = addGoalQuestion(goalRecord(), { body: '形式を選んでください' });
    const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
    let goal = question.goal;
    for (const notificationKind of Object.keys(policy) as Array<keyof typeof policy>) {
      goal = appendGoalNotification(goal, { kind: notificationKind, body: `${notificationKind} notice` }, policy);
    }
    goal.workLog.push({ id: '650e8400-e29b-41d4-a716-446655440090', recordedAt: '2026-10-14T00:00:00Z', summary: 'Checked current task state' });
    await new GoalStore(cwd).create(goal);
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    ${kind}: false\n`);
    invalidateResolvedConfigCache(cwd);
    const display = await readManagerDisplayEvents(cwd);
    expect(display.questions.map(({ question: saved }) => saved.id)).toEqual([question.questionId]);
    expect(display.events.map(({ id }) => JSON.parse(id)[2])).toEqual([
      goal.workLog[0]!.id, ...goal.notifications!.filter((notice) => notice.kind !== 'question' && notice.kind !== kind).map(({ id }) => id),
    ]);
    expect((await new GoalStore(cwd).get(goal.id)).notifications).toEqual(goal.notifications);
  },
);
