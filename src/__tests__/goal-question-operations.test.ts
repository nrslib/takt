import { beforeEach, expect, it, vi } from 'vitest';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), lock: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), send: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: doubles.lock }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: doubles.resolve, sendSavedGoalNotifications: doubles.send,
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
import { askTaktGoalQuestion, getTaktGoalQuestion, listTaktGoalQuestions, withdrawTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { firstTextContent } from './helpers/mcp-content.js';
let goal: Goal;
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(structuredClone(goal)); return structuredClone(goal);
  });
  doubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action());
  doubles.resolve.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
});

it('returns the saved question ID, reads its details and retains withdrawn questions in the list', async () => {
  const deps = { goalTurnOwners: { [input.goalId]: 'owner' } };
  const asked = await askTaktGoalQuestion({ ...input, body: '形式はどれですか', options: ['CSV', 'JSON'] }, deps, signal);
  expect(asked.isError).toBeUndefined();
  const id = goal.questions![0]!.id;
  expect(JSON.parse(firstTextContent(asked.content))).toEqual({ questionId: id });
  expect(goal.notifications?.[0]).toMatchObject({ kind: 'question' });
  expect(doubles.lock).toHaveBeenCalledWith(input.cwd, [input.goalId], expect.any(Function), deps.goalTurnOwners, signal);
  expect(doubles.send.mock.invocationCallOrder[0]).toBeGreaterThan(doubles.update.mock.invocationCallOrder[0]!);
  const detailed = await getTaktGoalQuestion({ ...input, questionId: id }, deps);
  expect(JSON.parse(firstTextContent(detailed.content))).toEqual({ question: goal.questions![0] });
  await withdrawTaktGoalQuestion({ ...input, questionId: id }, deps, signal);
  const listed = await listTaktGoalQuestions(input, deps);
  expect(JSON.parse(firstTextContent(listed.content))).toEqual({ questions: [expect.objectContaining({ id, status: 'withdrawn' })] });
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
  expect(goal.notifications?.[0]?.body).toBe(`${goal.questions![0]!.id}: ${body}\nOptions: CSV, JSON`);
});

it('keeps questions usable with question notification delivery disabled', async () => {
  doubles.resolve.mockReturnValue({ policy: { ...policy, question: false }, webhookUrl: undefined, mainMerge: 'approve' });
  await askTaktGoalQuestion({ ...input, body: '形式はどれですか' }, {}, signal);
  expect(goal.questions?.[0]?.status).toBe('pending');
  expect(goal.notifications).toBeUndefined();
});

it.each([true, false])('saves and exposes director questions without creating a human notification (notifications=%s)', async (enabled) => {
  doubles.resolve.mockReturnValue({ policy: { ...policy, question: enabled }, webhookUrl: undefined, mainMerge: 'approve' });
  const asked = await askTaktGoalQuestion({ ...input, body: '形式はどれですか', recipient: 'director' }, {}, signal);
  expect(asked.isError).toBeUndefined();
  const question = goal.questions![0]!;
  expect(question).toMatchObject({ recipient: 'director', status: 'pending' });
  expect(goal.notifications ?? []).toEqual([]);
  expect(JSON.parse(firstTextContent((await listTaktGoalQuestions(input, {})).content))).toEqual({ questions: [question] });
  expect(JSON.parse(firstTextContent((await getTaktGoalQuestion({ ...input, questionId: question.id }, {})).content))).toEqual({ question });
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
