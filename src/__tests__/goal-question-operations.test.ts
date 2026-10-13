import * as crypto from 'node:crypto';
import { beforeEach,expect,it,vi } from 'vitest';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { askTaktGoalQuestion,getTaktGoalQuestion,listTaktGoalQuestions,withdrawTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalSchema,type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
const doubles = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), lock: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), send: vi.fn(), language: vi.fn(),
}));
vi.mock('../infra/config/resolveConfigValue.js', async (original) => ({
  ...await original<typeof import('../infra/config/resolveConfigValue.js')>(), resolveConfigValue: doubles.language,
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: doubles.resolve, sendSavedGoalNotifications: doubles.send,
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
let goal: Goal;
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(crypto.randomUUID).mockImplementation(() => crypto.webcrypto.randomUUID());
  goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(structuredClone(goal)); return structuredClone(goal);
  });
  doubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action());
  doubles.resolve.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
  doubles.language.mockReturnValue('ja');
});

it('preserves question, notification and read operations for a paused goal', async () => {
  goal.executionStatus = 'paused';
  const asked = await askTaktGoalQuestion({ ...input, body: '形式はどれですか' }, {}, signal);
  expect(asked.isError).toBeUndefined();
  const id = goal.questions![0]!.id;
  expect((await getTaktGoalQuestion({ ...input, questionId: id }, {})).isError).toBeUndefined();
  expect((await notifyTaktGoal({ ...input, kind: 'custom', body: '一時停止中です' }, {}, signal)).isError).toBeUndefined();
  expect((await withdrawTaktGoalQuestion({ ...input, questionId: id }, {}, signal)).isError).toBeUndefined();
  expect(goal.executionStatus).toBe('paused');
  expect(goal.questions![0]!.status).toBe('withdrawn');
  expect(goal.notifications).toContainEqual(expect.objectContaining({ kind: 'custom', body: '一時停止中です' }));
});

it.each(['question', 'notify'] as const)('rejects %s for an aborted goal without saving or delivering it', async (kind) => {
  goal.executionStatus = 'aborted';
  const before = structuredClone(goal);

  const result = kind === 'question'
    ? await askTaktGoalQuestion({ ...input, body: '形式はどれですか' }, {}, signal)
    : await notifyTaktGoal({ ...input, kind: 'custom', body: '進捗の通知' }, {}, signal);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/goal.*abort/iu);
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.send).not.toHaveBeenCalled();
});

it('allows withdrawing and reading an existing question for an aborted goal', async () => {
  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  goal.executionStatus = 'aborted';
  goal.questions = [{ id: questionId, body: '形式はどれですか', recipient: 'human', status: 'pending' }];

  const result = await withdrawTaktGoalQuestion({ ...input, questionId }, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(goal.executionStatus).toBe('aborted');
  expect(goal.questions).toEqual([{ id: questionId, body: '形式はどれですか', recipient: 'human', status: 'withdrawn' }]);
  expect(JSON.parse(firstTextContent((await getTaktGoalQuestion({ ...input, questionId }, {})).content)))
    .toEqual({ question: goal.questions[0] });
  expect(JSON.parse(firstTextContent((await listTaktGoalQuestions(input, {})).content)))
    .toEqual({ questions: goal.questions });
});

it('persists a manager event with severity before delivery', async () => {
  const result = await notifyTaktGoal({ ...input, kind: 'blocked', body: '検証環境待ち', severity: 'warning' }, {}, signal);
  expect(result.isError).toBeUndefined();
  expect(goal.notifications).toEqual([expect.objectContaining({ kind: 'blocked', body: '検証環境待ち', severity: 'warning' })]);
  expect(doubles.send).toHaveBeenCalledOnce();
});

it('saves a maximum-length question and its complete generated notification', async () => {
  const body = 'Q'.repeat(128 * 1024);
  const options = ['CSV', 'JSON'];
  const result = await askTaktGoalQuestion({ ...input, body, options }, {}, signal);
  expect(result.isError).toBeUndefined();
  expect(GoalSchema.parse(goal).questions?.[0]).toMatchObject({ body, options });
  const notification = goal.notifications![0]!.body;
  expect(notification.startsWith(`${goal.questions![0]!.id}: ${body}\n`)).toBe(true);
  expect(notification.endsWith('選択肢: CSV, JSON')).toBe(true);
});

it.each(['ja', 'en'] as const)('saves question labels in the configured %s language without changing question data', async (language) => {
  doubles.language.mockReturnValue(language);
  const details = { body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV' };
  const result = await askTaktGoalQuestion({ ...input, ...details }, {}, signal);
  expect(result.isError).toBeUndefined();
  const question = goal.questions![0]!;
  expect(question).toMatchObject({ ...details, recipient: 'human', status: 'pending' });
  expect(goal.notifications?.[0]?.body).toBe(language === 'ja'
    ? `${question.id}: ${details.body}\n選択肢: CSV, JSON\n推奨: CSV`
    : `${question.id}: ${details.body}\nOptions: CSV, JSON\nRecommendation: CSV`);
  expect(GoalSchema.parse(goal)).toEqual(goal);
  expect(doubles.send).toHaveBeenCalledWith(input.cwd, expect.objectContaining({ id: goal.id }), goal, undefined);
});

it('keeps questions usable with question notification delivery disabled', async () => {
  doubles.resolve.mockReturnValue({ policy: { ...policy, question: false }, webhookUrl: undefined, mainMerge: 'approve' });
  await askTaktGoalQuestion({ ...input, body: '形式はどれですか' }, {}, signal);
  expect(goal.questions?.[0]?.status).toBe('pending');
  expect(goal.notifications).toBeUndefined();
});

it('returns read and write errors for missing questions and persistence failure', async () => {
  expect((await getTaktGoalQuestion({ ...input, questionId: 'missing' }, {})).isError).toBe(true);
  expect((await withdrawTaktGoalQuestion({ ...input, questionId: 'missing' }, {}, signal)).isError).toBe(true);
  doubles.update.mockRejectedValueOnce(new Error('publication failed'));
  expect((await askTaktGoalQuestion({ ...input, body: '形式はどれですか' }, {}, signal)).isError).toBe(true);
  expect(goal.questions).toBeUndefined();
  expect(doubles.send).not.toHaveBeenCalled();
});

it('rejects a root outside the MCP scope before reading or saving', async () => {
  doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });
  expect((await listTaktGoalQuestions(input, {})).isError).toBe(true);
  expect((await getTaktGoalQuestion({ ...input, questionId: 'missing' }, {})).isError).toBe(true);
  expect((await notifyTaktGoal({ ...input, kind: 'custom', body: '通知' }, {}, signal)).isError).toBe(true);
  expect(doubles.get).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.lock).not.toHaveBeenCalled();
});
