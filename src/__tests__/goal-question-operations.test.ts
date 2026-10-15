import * as crypto from 'node:crypto';
import { beforeEach,expect,it,vi } from 'vitest';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { askTaktGoalQuestion,getTaktGoalQuestion,listTaktGoalQuestions,withdrawTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalSchema,type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { listTaktGoalRecords, recordTaktGoalWorkLog } from '../features/mcp/goalWorkLogOperations.js';
import { listGoalRecordsInputSchema } from '../features/mcp/schemas.js';
import { responseBytes, MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
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
    .toMatchObject({ questions: goal.questions, totalCount: 1, truncated: false });
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

it('preserves question changes made before the update reads the goal', async () => {
  const previousQuestion = {
    id: '650e8400-e29b-41d4-a716-446655440001', body: '先の質問', recipient: 'human' as const, status: 'pending' as const,
  };
  goal.questions = [previousQuestion];
  doubles.update.mockImplementationOnce(async (_id: string, transform: (current: Goal) => Goal) => {
    const current = { ...goal, questions: [
      { ...previousQuestion, status: 'answered' as const, answer: { text: 'CSV', source: 'tui' as const, answeredAt: '2026-10-14T00:00:00Z' } },
      { ...previousQuestion, id: '650e8400-e29b-41d4-a716-446655440002', body: '別の質問' },
    ] };
    goal = transform(current);
    return structuredClone(goal);
  });

  const result = await askTaktGoalQuestion({ ...input, body: '新しい質問' }, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(goal.questions).toEqual([
    expect.objectContaining({ id: previousQuestion.id, status: 'answered', answer: expect.objectContaining({ text: 'CSV' }) }),
    expect.objectContaining({ body: '別の質問', status: 'pending' }),
    expect.objectContaining({ body: '新しい質問', status: 'pending' }),
  ]);
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ questionId: goal.questions![2]!.id });
  expect(goal.notifications).toHaveLength(1);
});

it('reuses a pending question from the update without adding a duplicate notification', async () => {
  const question = {
    id: '650e8400-e29b-41d4-a716-446655440001', body: '形式はどれですか', recipient: 'human' as const, status: 'pending' as const,
  };
  doubles.update.mockImplementationOnce(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform({ ...goal, questions: [question] });
    return structuredClone(goal);
  });

  const result = await askTaktGoalQuestion({ ...input, body: question.body }, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ questionId: question.id });
  expect(goal.questions).toEqual([question]);
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

it('bounds question reads, creation, withdrawal, notifications and work-log writes with large saved histories', async () => {
  goal.workLog = Array.from({ length: 100 }, (_, index) => ({ id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, summary: `記録${index}:` + '作業'.repeat(10000), recordedAt: '2026-10-14T00:00:00Z' }));
  goal.questions = Array.from({ length: 100 }, (_, index) => ({ id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '質問'.repeat(20000), status: 'pending', recipient: 'human' }));
  goal.notifications = Array.from({ length: 100 }, (_, index) => ({ id: `750e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '通知'.repeat(20000), kind: 'custom', recordedAt: '2026-10-14T00:00:00Z' }));
  const questionId = goal.questions[99]!.id;
  const previous = structuredClone(goal.workLog);
  const results = [
    await getTaktGoalQuestion({ ...input, questionId }, {}),
    await listTaktGoalQuestions(input, {}),
    await askTaktGoalQuestion({ ...input, body: '新しい質問'.repeat(20000) }, {}, signal),
    await withdrawTaktGoalQuestion({ ...input, questionId }, {}, signal),
    await notifyTaktGoal({ ...input, body: '更新通知'.repeat(20000), kind: 'custom' }, {}, signal),
    await recordTaktGoalWorkLog({ ...input, summary: '保存内容'.repeat(20000) }, {}, signal),
    await listTaktGoalRecords(input, {}),
  ];
  for (const result of results) {
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  }
  const saved = JSON.parse(firstTextContent(results[5]!.content));
  expect(saved.totalCount).toBe(101);
  expect(saved.entry.id).toBe(goal.workLog[100]!.id);
  expect(saved).not.toHaveProperty('workLog');
  expect(JSON.parse(firstTextContent(results[3]!.content))).toMatchObject({
    goalId: goal.id, status: 'created', questionId, questionStatus: 'withdrawn',
  });
  expect(JSON.parse(firstTextContent(results[4]!.content))).toMatchObject({
    goal: { id: goal.id, status: 'created' }, notificationId: goal.notifications!.at(-1)!.id,
  });
  expect(goal.workLog.slice(0, 100)).toEqual(previous);
  expect(goal.workLog[100]!.summary).toBe('保存内容'.repeat(20000));
  expect(goal.questions.find((question) => question.id === questionId)!.status).toBe('withdrawn');
  const first = JSON.parse(firstTextContent((await getTaktGoalQuestion({ ...input, questionId, path: 'body', maxBytes: 12 }, {})).content));
  const next = JSON.parse(firstTextContent((await getTaktGoalQuestion({ ...input, questionId, path: 'body', maxBytes: 12, textOffset: first.nextOffset }, {})).content));
  expect(first).toMatchObject({ content: '質問質問', nextOffset: 12, truncated: true });
  expect(next.offset).toBe(12);
});

it.each([undefined, 1, 50])('returns recent work with limit %s and a usable continuation', async (limit) => {
  goal.workLog = Array.from({ length: 60 }, (_, index) => ({ id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, summary: `記録${index}`, recordedAt: '2026-10-14T00:00:00Z' }));
  const first = JSON.parse(firstTextContent((await listTaktGoalRecords({ ...input, limit }, {})).content));
  expect(first.workLog).toHaveLength(limit ?? 50);
  expect(first.workLog[0].summary).toBe('記録59');
  const next = JSON.parse(firstTextContent((await listTaktGoalRecords({ ...input, limit, offset: first.nextOffset }, {})).content));
  expect(next.workLog[0].summary).toBe(`記録${59 - (limit ?? 50)}`);
});

it.each([0, 51, -1, 1.5])('rejects a work-log limit of %s', (limit) => {
  expect(listGoalRecordsInputSchema.safeParse({ ...input, limit }).success).toBe(false);
});

it('puts pending questions first and retrieves the next pending question with its returned ID', async () => {
  const first = { id: '650e8400-e29b-41d4-a716-446655440001', body: '古い質問', recipient: 'human' as const, status: 'withdrawn' as const };
  const second = { ...first, id: '650e8400-e29b-41d4-a716-446655440002', body: '確認1', status: 'pending' as const };
  const third = { ...second, id: '650e8400-e29b-41d4-a716-446655440003', body: '確認2' };
  goal.questions = [first, second, third];
  const page = JSON.parse(firstTextContent((await listTaktGoalQuestions({ ...input, limit: 1 }, {})).content));
  expect(page).toMatchObject({ questions: [second], totalCount: 3, nextOffset: 1, omittedCount: 2 });
  const next = JSON.parse(firstTextContent((await listTaktGoalQuestions({ ...input, limit: 1, offset: page.nextOffset }, {})).content));
  expect(next.questions[0]).toEqual(third);
  expect(JSON.parse(firstTextContent((await getTaktGoalQuestion({ ...input, questionId: next.questions[0].id }, {})).content)).question).toEqual(third);
});
