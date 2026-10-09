import { beforeEach, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
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
  vi.mocked(crypto.randomUUID).mockImplementation(() => crypto.webcrypto.randomUUID());
  goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(structuredClone(goal)); return structuredClone(goal);
  });
  doubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action());
  doubles.resolve.mockReturnValue({ policy, webhookUrl: undefined, mainMerge: 'approve' });
});

it.each(['question', 'notify'] as const)('settles %s validation failures and requires a new name for corrected arguments', async (kind) => {
  const existingId = '650e8400-e29b-41d4-a716-446655440001';
  goal.events = [{ id: 'event-a', kind: 'completion', taskName: 'trigger', runSlug: 'run-a',
    result: { success: true, interrupted: false }, processed: false }];
  if (kind === 'question') goal.questions = [{ id: existingId, body: '既存の質問', recipient: 'human', status: 'pending' }];
  else goal.notifications = [{ id: existingId, kind: 'custom', body: '既存の通知', recordedAt: '2026-10-08T00:00:00Z' }];
  const deps = { goalEventContext: { goalId: goal.id, eventId: 'event-a' } };
  const request = { ...input, operationName: `${kind}:format`, body: '新しい内容' };
  const write = (request: typeof input & { operationName: string; body: string }) => kind === 'question'
    ? askTaktGoalQuestion(request, deps, signal) : notifyTaktGoal({ ...request, kind: 'custom' }, deps, signal);
  const before = structuredClone(goal);
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(existingId);
  const failed = await write(request);
  expect(failed.isError).toBe(true);
  expect(goal.operations).toEqual([expect.objectContaining({ status: 'failed', tool: kind, eventId: 'event-a',
    operationName: request.operationName, arguments: { body: request.body, ...(kind === 'notify' ? { kind: 'custom' } : {}) },
    result: { status: 'failed', reason: expect.any(String) } })]);
  expect({ ...goal, operations: before.operations }).toEqual(before);
  expect(doubles.send).not.toHaveBeenCalled();
  const settled = structuredClone(goal);
  expect(await write(request)).toEqual(failed);
  expect((await write({ ...request, body: '修正した内容' })).isError).toBe(true);
  expect(goal).toEqual(settled);
  expect(crypto.randomUUID).toHaveBeenCalledOnce();
  expect(doubles.send).not.toHaveBeenCalled();
  const result = await write({ ...request, operationName: `${kind}:format:corrected`, body: '修正した内容' });
  expect(result.isError).toBeUndefined();
  expect(goal.operations).toEqual([settled.operations![0], expect.objectContaining({ status: 'completed',
    operationName: `${kind}:format:corrected`, result: JSON.parse(firstTextContent(result.content)) })]);
  expect(kind === 'question' ? goal.questions : goal.notifications).toHaveLength(2);
  expect(doubles.send).toHaveBeenCalledOnce();
});

it('settles withdrawal precondition failures and does not revalidate the same operation', async () => {
  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  const missingId = '650e8400-e29b-41d4-a716-446655440002';
  goal.events = [{ id: 'event-a', kind: 'completion', taskName: 'trigger', runSlug: 'run-a',
    result: { success: true, interrupted: false }, processed: false }];
  goal.questions = [{ id: questionId, body: '質問', recipient: 'human', status: 'pending' }];
  const deps = { goalEventContext: { goalId: goal.id, eventId: 'event-a' } };
  const request = { ...input, operationName: 'withdraw:format', questionId: missingId };
  const failed = await withdrawTaktGoalQuestion(request, deps, signal);
  expect(failed.isError).toBe(true);
  expect(goal.operations?.[0]).toMatchObject({ status: 'failed', tool: 'withdraw_question',
    arguments: { questionId: missingId }, result: { status: 'failed', reason: expect.any(String) } });
  goal.questions.push({ id: missingId, body: '後から追加した質問', recipient: 'human', status: 'pending' });
  const settled = structuredClone(goal);
  expect(await withdrawTaktGoalQuestion(request, deps, signal)).toEqual(failed);
  expect((await withdrawTaktGoalQuestion({ ...request, questionId }, deps, signal)).isError).toBe(true);
  expect(goal).toEqual(settled);
  expect(doubles.send).not.toHaveBeenCalled();
  expect((await withdrawTaktGoalQuestion({ ...request, operationName: 'withdraw:format:corrected', questionId }, deps, signal)).isError).toBeUndefined();
  expect(goal.questions[0]?.status).toBe('withdrawn');
  expect(goal.questions[1]?.status).toBe('pending');
  expect(goal.operations).toEqual([settled.operations![0], expect.objectContaining({ status: 'completed' })]);
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
