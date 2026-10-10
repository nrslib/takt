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
    session = undefined;
    invalidateGlobalConfigCache();
    invalidateResolvedConfigCache(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
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
