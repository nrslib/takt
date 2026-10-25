const failureNotice = vi.hoisted(() => vi.fn());
vi.mock('../../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: failureNotice }));
import { cleanup,render } from 'ink-testing-library';
import { createElement,type ComponentProps } from 'react';
import { afterEach,beforeEach,expect,vi,type Mock,type MockedFunction } from 'vitest';
import { ManagerView } from '../../features/manager/ManagerView.js';
import { createManagerConversationSession, type ManagerConversationSession } from '../../features/manager/conversationSession.js';
import { toDisplayText } from '../../features/tui/displayText.js';
import type { Goal, ManagerGoalSummary } from '../../infra/goals/schema.js';
import { GoalCreateInputSchema,GoalSchema } from '../../infra/goals/schema.js';
import { createGoal } from '../../infra/goals/service.js';
import type { ProviderAgent } from '../../infra/providers/types.js';
import { goalRecord } from './goal-fixtures.js';
import { makeProvider } from '../test-helpers.js';
vi.mock('../../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../../infra/goals/service.js', () => ({ createGoal: vi.fn() }));
const memory = vi.hoisted(() => ({ goals: vi.fn((_directory: string) => [] as Goal[]) }));
vi.mock('../../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly directory: string) {}
  async list<T = Goal>(project: (goal: Goal) => T | undefined = (goal) => goal as T) {
    return { goals: memory.goals(this.directory).map(project).filter((goal) => goal !== undefined), errors: [] };
  }
  async get(id: string) { return { ...goalRecord(), id }; }
} }));
vi.mock('../../infra/goals/standalone-inquiries.js', async (original) => {
  const actual = await original<typeof import('../../infra/goals/standalone-inquiries.js')>();
  return { ...actual, StandaloneInquiryStore: class extends actual.StandaloneInquiryStore {
    async listPending() { return []; }
  } };
});
const inbox = vi.hoisted(() => ({ read: vi.fn(() => [] as unknown[]), remove: vi.fn() }));
vi.mock('../../infra/goals/events.js', () => ({ readManagerEvents: inbox.read, deleteManagerEvent: inbox.remove, saveManagerEvent: vi.fn(), deleteGoalEvents: vi.fn() }));
vi.mock('../../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../../features/daemon/lifecycle.js', () => ({ ensureDaemon: vi.fn(async () => {}) }));
const startupDoubles = vi.hoisted(() => ({ flush: vi.fn(async () => {}) }));
export { failureNotice, memory, inbox, startupDoubles };
vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return { ...original, useApp: () => ({ ...original.useApp(), waitUntilRenderFlush: startupDoubles.flush }) };
});

export const cwd = '/test/manager-repository';
export const summaryA = { objective: 'CSVを出力する', outOfScope: ['JSON出力'], acceptanceCriteria: ['CSVを取得できる'], constraints: ['mock provider のみ'], };
export const summaryB = { objective: 'JSONを出力する', outOfScope: ['CSV出力', '通知'], acceptanceCriteria: ['JSONを取得できる', '列名を含む'], startBranch: 'release', integrationBranch: 'main', constraints: [], };
export const ENTER = '\r';
export const UP = '\x1b[A';
const DOWN = '\x1b[B';
export const QUESTION_MENU = '\x12';
export const GOAL_MENU = '\x07';
export const SUMMARY_MENU = '\x0f';
export const LONG_TEXT = `${'長い貼り付け本文を確認してください。'.repeat(80)}末尾の確認`;

export function response(summary: typeof summaryA | null) {
  const structuredOutput = { message: 'Please review the summary.', summary };
  return { persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify(structuredOutput), structuredOutput };
}

type ManagerTuiContext = {
  app: ReturnType<typeof render>;
  call: Mock<ProviderAgent['call']>;
  register: MockedFunction<typeof createGoal>;
  session: ManagerConversationSession;
  lang: 'ja' | 'en';
  onExit: Mock<() => void>;
};

export function mount(lang: 'ja' | 'en' = 'en', startup?: ComponentProps<typeof ManagerView>['startup'], assignment?: ComponentProps<typeof ManagerView>['assignment']): ManagerTuiContext {
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async (prompt) => response(prompt.includes('goalRegistered') ? null : summaryA));
  const register = vi.mocked(createGoal);
  register.mockImplementation(async ({ cwd: _cwd, ...input }) => ({ ...goalRecord(), ...input }));
  const session = createManagerConversationSession({
    cwd, assignment,
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang, provider: makeProvider({ supportsStructuredOutput: true, setup: () => ({ call }) }) },
      strategy: { systemPrompt: 'manager fixture' },
    },
  });
  const onExit = vi.fn();
  const app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit, startup, assignment }));
  return { app, call, register, session, lang, onExit };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

export function promptFrame(context: ReturnType<typeof mount>): string {
  const frame = context.app.lastFrame()!;
  return frame.slice(frame.lastIndexOf('╭'));
}

export function queuedFrame(context: ReturnType<typeof mount>): string | undefined {
  return context.app.lastFrame()?.match(/╭[\s\S]*?╰[^\n]*/gu)
    ?.find((frame) => /\n│\s*(?:送信待ち|queued messages|pending messages)\s*:\s*\d+/iu.test(frame));
}

export function selectionFrame(context: ReturnType<typeof mount>): string | undefined {
  return context.app.lastFrame()?.match(/╭[^\n]*\n[\s\S]*?╰[^\n]*/gu)?.find((box) =>
    /↑|↓/u.test(box) && /Enter/u.test(box) && /Esc/u.test(box)
    && !/Free text|cannot.*undo|取り消せ|元に戻せ/iu.test(box));
}

export async function enterSelection(context: ReturnType<typeof mount>): Promise<void> {
  await vi.waitFor(() => expect(selectionFrame(context)).toBeDefined(), { timeout: 1500 });
  context.app.stdin.write(ENTER);
}

export async function openMenu(context: ReturnType<typeof mount>, kind: 'answer' | 'goal'): Promise<void> {
  await waitFor(() => expect(context.app.lastFrame()).toContain('manager-repository'));
  context.app.stdin.write(kind === 'answer' ? QUESTION_MENU : GOAL_MENU);
}

export async function chooseGoalAction(context: ReturnType<typeof mount>, action: 'pause' | 'resume' | 'abort'): Promise<void> {
  const patterns = { pause: /一時停止|pause/iu, resume: /再開|resume/iu, abort: /中止|abort/iu };
  const actionRows = (): string[] => selectionFrame(context)!.split('\n').slice(2, -2)
    .filter((row) => Object.values(patterns).some((pattern) => pattern.test(row)));
  await waitFor(() => {
    const list = selectionFrame(context);
    expect(list).toBeDefined();
    expect(actionRows()).toHaveLength(2);
    expect(actionRows().some((row) => patterns[action].test(row))).toBe(true);
  });
  const rows = actionRows();
  const index = rows.findIndex((row) => patterns[action].test(row));
  expect(index).toBeGreaterThanOrEqual(0);
  context.app.stdin.write(UP);
  context.app.stdin.write(UP);
  for (let move = 0; move < index; move++) context.app.stdin.write(DOWN);
  context.app.stdin.write(ENTER);
}

export function waitFor(assertions: () => void): Promise<void> {
  return vi.waitFor(assertions, { timeout: 10_000 });
}

export async function typeAndSubmit(context: ReturnType<typeof mount>, text: string): Promise<void> {
  context.app.stdin.write(text);
  await waitFor(() => expect(promptFrame(context)).toContain(text.replace(/\t/gu, ' ')));
  context.app.stdin.write(ENTER);
  await waitFor(() => {
    expect(promptFrame(context)).toMatch(/Discuss your goal|Enter your answer|ゴールを相談してください|回答を入力してください/u);
    expect(promptFrame(context)).not.toContain(text);
  });
}

export async function send(context: ReturnType<typeof mount>, text: string, summary: ManagerGoalSummary) {
  const { app, call, session } = context;
  const before = call.mock.calls.length;
  app.stdin.write(text);
  await waitFor(() => expect(promptFrame(context)).toContain(text));
  app.stdin.write(ENTER);
  await waitFor(() => {
    expect(call).toHaveBeenCalledTimes(before + 1);
    expect(session.getPendingSummary()?.summary).toEqual(summary);
    const frame = app.lastFrame();
    expect(queuedFrame(context)).toBeUndefined();
    expect(promptFrame(context)).toContain(context.lang === 'ja' ? 'ゴールを相談してください' : 'Discuss your goal');
    expect(frame).toContain(summary.objective);
    expect(frame).toContain(context.lang === 'ja' ? '範囲外:' : 'Out of scope:');
    expect(frame).toContain(context.lang === 'ja' ? '受け入れ条件:' : 'Acceptance criteria:');
    for (const item of [...summary.outOfScope, ...summary.acceptanceCriteria, ...summary.constraints]) {
      expect(frame).toContain(`- ${toDisplayText(item).split('\n')[0]}`);
    }
    if (summary.startBranch !== undefined) expect(frame).toContain(`startBranch: ${summary.startBranch}`);
    if (summary.integrationBranch !== undefined) expect(frame).toContain(`integrationBranch: ${summary.integrationBranch}`);
  });
}

export async function approve(context: ReturnType<typeof mount>, summary: ManagerGoalSummary) {
  const { app, register } = context;
  expect(register).not.toHaveBeenCalled();

  app.stdin.write(UP);
  app.stdin.write(ENTER);

  await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd, ...summary }));
  const request = GoalCreateInputSchema.parse(register.mock.calls[0]![0]);
  expect(request).toMatchObject({ cwd, ...summary });
  const registered = GoalSchema.parse(await register.mock.results[0]!.value);
  await waitFor(() => {
    expect(app.lastFrame()).toContain(registered.id);
    expect(app.lastFrame()).toContain(registered.branch);
    expect(app.lastFrame()).not.toContain(context.lang === 'ja' ? '処理中' : 'Working');
    expect(queuedFrame(context)).toBeUndefined();
  });
}

beforeEach(() => { vi.clearAllMocks(); failureNotice.mockReset(); memory.goals.mockReturnValue([]); inbox.read.mockReturnValue([]); startupDoubles.flush.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
