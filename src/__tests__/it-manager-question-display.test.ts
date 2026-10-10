import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../infra/goals/notifications.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../infra/goals/questions.js';
import { GoalStore } from '../infra/goals/store.js';
import { MockProvider } from '../infra/providers/mock.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { processGoalCompletions } from '../features/manager/completionTurn.js';
import { recordGoalCompletion } from '../infra/goals/reconcile.js';
import * as managerPlans from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';

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
  const callTool = vi.fn();
  session = createManagerConversationSession({
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool },
    plan: { ctx: { providerType: 'mock', model: undefined, lang, provider },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
  });
  app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => expect(app!.lastFrame()!.replace(/\n/gu, '')).toContain(cwd));
  const send = async (text: string): Promise<void> => {
    app!.stdin.write(text);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(text.split('\n')[0]!));
    app!.stdin.write('\r');
  };
  return { store, call, callTool, send };
}

it.each(['ja', 'en'] as const)('pauses and resumes an awaiting-merge goal from commands in the same %s TUI while preserving evidence', async (lang) => {
  const saved: Goal = { ...goalRecord(), objective: 'Goal display fixture', status: 'awaiting_merge',
    completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready for integration',
      changeSummary: { filesChanged: 1, additions: 2, deletions: 0,
        files: [{ path: 'result.txt', additions: 2, deletions: 0 }], truncated: false, totalsTruncated: false },
      instructions: ['git merge --ff-only goal-branch'],
    },
  };
  const { store, call, callTool, send } = await mountGoalControls(lang, saved);
  await send(`/pause ${goalId}`);
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('paused'));
  expect(await store.get(goalId)).toEqual({ ...saved, executionStatus: 'paused' });
  await vi.waitFor(() => {
    const rows = app!.lastFrame()!.split('\n');
    const goalRow = rows.findIndex((row) => row.includes(saved.objective));
    expect(goalRow).toBeGreaterThanOrEqual(0);
    expect(rows.slice(Math.max(0, goalRow - 1), goalRow + 3).join('\n')).toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
  });
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  await send(`/resume ${goalId}`);
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('active'));
  expect(await store.get(goalId)).toEqual(saved);
  await vi.waitFor(() => {
    const rows = app!.lastFrame()!.split('\n');
    const goalRow = rows.findIndex((row) => row.includes(saved.objective));
    if (goalRow !== -1) expect(rows.slice(Math.max(0, goalRow - 1), goalRow + 3).join('\n')).not.toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
  });
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
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
  expect(call.mock.calls[0]![0]).toBe(text);
  expect(await store.get(goalId)).toEqual(saved);
});

it.each([false, true])('preserves the saved completion identity across pause and resume (previously saved=%s)', async (previouslySaved) => {
  const store = new GoalStore(cwd);
  await store.create({ ...goalRecord(), executionStatus: 'paused' });
  const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'a'.repeat(40) } };
  if (previouslySaved) await recordGoalCompletion(cwd, goalId, completion);
  const previousId = (await store.get(goalId)).events?.[0]?.id;
  const provider = new MockProvider();
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date(),
    content: '', structuredOutput: { message: 'saved completion processed', summary: null } });
  vi.spyOn(provider, 'setup').mockReturnValue({ call });
  const plan = { ctx: { providerType: 'mock' as const, model: undefined, lang: 'ja' as const, provider },
    strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } };
  vi.spyOn(managerPlans, 'createManagerConversationPlan').mockReturnValue(plan);
  vi.spyOn(managerMcp, 'prepareManagerMcp').mockResolvedValue({ command: process.execPath, args: [], env: {}, servers: {}, dispose: async () => {} });
  session = createManagerConversationSession({ cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() }, plan });
  await processGoalCompletions(cwd, goalId, {}, completion);
  const paused = await store.get(goalId);
  expect(paused.events).toEqual([expect.objectContaining({ ...completion, id: expect.any(String), kind: 'completion', processed: false })]);
  if (previouslySaved) expect(paused.events![0]!.id).toBe(previousId);
  expect(call).not.toHaveBeenCalled();
  const event = paused.events![0]!;
  expect((await session.resumeGoal({ goalId })).kind).toBe('reply');
  expect((await store.get(goalId)).events).toEqual([{ ...event, processed: true, summary: 'saved completion processed' }]);
  expect(call).toHaveBeenCalledOnce();
  expect(JSON.parse(call.mock.calls[0]![0]).event.id).toBe(event.id);
});

it('shows pending questions and their answer commands when question notifications are disabled, excluding withdrawn questions on reopening', async () => {
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
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
    },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));

  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`${goalId}: ${saved.objective}`);
    expect(frame).toContain(`${added.questionId}: ${input.body}`);
    expect(frame).toContain('CSV / JSON');
    expect(frame).toContain(`推奨: ${input.recommendation}`);
    expect(frame).toContain(`/answer ${added.questionId}`);
    expect(frame).toContain(`/answer ${remaining.questionId}`);
  });

  app.unmount();
  await store.update(goalId, (goal) => withdrawGoalQuestion(goal, added.questionId));
  const display = await readManagerDisplayEvents(cwd);
  expect(display.events).toEqual([]);
  expect(display.diagnostics).toEqual([]);
  expect(display.questions.map(({ question }) => question.id)).toEqual([remaining.questionId]);
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));

  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`/answer ${remaining.questionId}`);
    expect(frame).not.toContain(added.questionId);
    expect(frame).not.toContain(input.body);
  });
});

it.each([true, false])('shows only human questions and their saved automatic notifications in the TUI (notifications=%s)', async (enabled) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    question: ${enabled}\n`);
  invalidateResolvedConfigCache(cwd);
  const human = addGoalQuestion(goalRecord(), { recipient: 'human', body: '出力形式はどれですか' });
  const director = addGoalQuestion(human.goal, { recipient: 'director', body: '出力形式はどれですか' });
  const questions = director.goal.questions!;
  const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
  let saved = director.goal;
  for (const question of questions) saved = appendGoalNotification(saved, { kind: 'question', body: formatGoalQuestionNotification(question) }, policy);
  saved = appendGoalNotification(saved, { kind: 'custom', body: `${director.questionId}: 一般通知` }, policy);
  saved = appendGoalNotification(saved, { kind: 'question', body: `関連質問 ${director.questionId}: 本文中のID` }, policy);
  await new GoalStore(cwd).create(saved);
  const display = await readManagerDisplayEvents(cwd);
  expect(display.questions.map(({ question }) => question.id)).toEqual([human.questionId]);
  expect(display.events.map(({ id }) => JSON.parse(id)[2])).toEqual([
    saved.notifications![0]!.id, saved.notifications![2]!.id, saved.notifications![3]!.id,
  ]);
  session = createManagerConversationSession({
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    plan: { ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`/answer ${human.questionId}`);
    expect(frame).not.toContain(`/answer ${director.questionId}`);
    expect(frame).toContain(`${director.questionId}: 一般通知`);
  });
});
