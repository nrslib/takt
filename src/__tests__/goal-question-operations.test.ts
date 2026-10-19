import * as crypto from 'node:crypto';
import { beforeEach,expect,it,vi } from 'vitest';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { askTaktGoalQuestion,getTaktGoalQuestion,listTaktGoalQuestions,withdrawTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { GoalQuestionSchema,GoalSchema,type Goal } from '../infra/goals/schema.js';
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
  get: vi.fn(), update: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), send: vi.fn(), language: vi.fn(),
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
  expect(goal.questions).toEqual([expect.objectContaining({
    id: questionId, body: '形式はどれですか', recipient: 'human', status: 'withdrawn', withdrawnAt: expect.any(String),
  })]);
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

it.each((['question', 'operation_request'] as const).flatMap((kind) =>
  (['before request', 'before update', 'awaiting merge'] as const).map((timing) => ({ kind, timing })),
))('checks completion before saving a $kind inquiry: $timing', async ({ kind, timing }) => {
  goal = GoalSchema.parse({
    ...goal, status: timing === 'before request' ? 'completed' : 'awaiting_merge',
    completion: {
      goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: goal.integrationBranch,
      targetSha: 'b'.repeat(40), summary: 'evidence', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    },
    questions: [{
      id: '650e8400-e29b-41d4-a716-446655440001', body: '確認してください', kind,
      recipient: 'human', status: 'withdrawn', withdrawalReason: 'Goal was completed', withdrawnAt: '2026-10-19T03:00:00.000Z',
    }],
  });
  const initial = structuredClone(goal);
  const latest = GoalSchema.parse({ ...goal, status: timing === 'awaiting merge' ? 'awaiting_merge' : 'completed' });
  const observed: Goal[] = [];
  const update = doubles.update.getMockImplementation()!;
  doubles.update.mockImplementationOnce(async (id: string, transform: (current: Goal) => Goal) => {
    goal = structuredClone(latest);
    return update(id, (current: Goal) => {
      observed.push(structuredClone(current));
      return GoalSchema.parse(transform(current));
    });
  });

  const result = await askTaktGoalQuestion({ ...input, body: '確認してください', kind }, {}, signal);

  expect(await doubles.get.mock.results[0]!.value).toEqual(initial);
  expect(observed).toEqual([latest]);
  if (timing === 'awaiting merge') {
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    expect(goal.questions).toEqual([...latest.questions!, expect.objectContaining({ kind, status: 'pending' })]);
    expect(goal.notifications).toHaveLength(1);
    expect(doubles.send).toHaveBeenCalledOnce();
  } else {
    expect(result.isError).toBe(true);
    expect(goal).toEqual(latest);
    expect(doubles.send).not.toHaveBeenCalled();
  }
  const listed = await listTaktGoalQuestions(input, {});
  expect(listed.isError, firstTextContent(listed.content)).toBeUndefined();
  expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ questions: [
    ...(timing === 'awaiting merge' ? [expect.objectContaining({
      id: goal.questions!.at(-1)!.id, body: '確認してください', kind, status: 'pending',
    })] : []), ...latest.questions!,
  ], totalCount: timing === 'awaiting merge' ? 2 : 1 });
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

it.each([undefined, 'question', 'operation_request'] as const)('saves kind %s and target SHA through the question operation', async (kind) => {
  const details = { ...input, body: '認証を確認してください', ...(kind === undefined ? {} : { kind }), targetSha: 'a'.repeat(40) };
  const result = await askTaktGoalQuestion(details, {}, signal);
  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  const { questionId } = JSON.parse(firstTextContent(result.content));
  const read = await getTaktGoalQuestion({ ...input, questionId }, {});
  expect(JSON.parse(firstTextContent(read.content)).question).toMatchObject({
    id: questionId, body: details.body, kind: kind ?? 'question', targetSha: details.targetSha, status: 'pending',
  });
});

it('rejects approval creation before saving or delivering a notification', async () => {
  const details = { ...input, body: '操作を許可しますか', kind: 'approval' } as unknown as Parameters<typeof askTaktGoalQuestion>[0];
  const result = await askTaktGoalQuestion(details, {}, signal);
  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/approval|承認/iu);
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.send).not.toHaveBeenCalled();
  expect(goal.questions).toBeUndefined();
});

it.each(['question', 'operation_request'] as const)('creates a separate %s inquiry and returns its ID when another kind has the same body', async (kind) => {
  const old = GoalQuestionSchema.parse({
    id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending',
    body: '確認してください', kind: kind === 'question' ? 'operation_request' : 'question',
  });
  goal.questions = [old];
  const details = { ...input, body: old.body, kind };
  const result = await askTaktGoalQuestion(details, {}, signal);
  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(goal.questions).toHaveLength(2);
  const created = goal.questions![1]!;
  expect(created).toMatchObject({ body: old.body, kind, status: 'pending' });
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ questionId: created.id });
  expect(created.id).not.toBe(old.id);
  expect(goal.notifications).toHaveLength(1);
});

it('reuses the matching kind when a different kind appears first with the same body', async () => {
  goal.questions = [
    GoalQuestionSchema.parse({ id: '650e8400-e29b-41d4-a716-446655440001', body: '確認してください', status: 'pending', kind: 'question' }),
    GoalQuestionSchema.parse({ id: '650e8400-e29b-41d4-a716-446655440002', body: '確認してください', status: 'pending', kind: 'operation_request' }),
  ];
  const before = structuredClone(goal.questions);
  const details = { ...input, body: '確認してください', kind: 'operation_request' as const };
  const result = await askTaktGoalQuestion(details, {}, signal);
  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ questionId: before[1]!.id });
  expect(goal.questions).toEqual(before);
  expect(goal.notifications).toBeUndefined();
});

it.each([undefined, '  別の方法で解決しました\n'])('saves withdrawal time and optional reason %j through MCP operations', async (reason) => {
  const question = GoalQuestionSchema.parse({ id: '650e8400-e29b-41d4-a716-446655440001', body: '確認してください', status: 'pending' });
  goal.questions = [question];
  const before = Date.now();
  const details = { ...input, questionId: question.id, ...(reason === undefined ? {} : { reason }) };
  const result = await withdrawTaktGoalQuestion(details, {}, signal);
  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  const saved = goal.questions![0]!;
  expect(saved).toMatchObject({ id: question.id, status: 'withdrawn' });
  expect(saved.withdrawalReason).toBe(reason);
  expect(Date.parse(saved.withdrawnAt!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(saved.withdrawnAt!)).toBeLessThanOrEqual(Date.now());
  const read = await getTaktGoalQuestion({ ...input, questionId: question.id }, {});
  expect(JSON.parse(firstTextContent(read.content)).question).toEqual(saved);
});

it('returns structured answers, withdrawal details and consumed approval state from both reads', async () => {
  const now = '2026-10-19T01:00:00.000Z';
  const base = { recipient: 'human', body: '確認してください', createdAt: now };
  const records = [
    { ...base, id: '650e8400-e29b-41d4-a716-446655440001', kind: 'question', status: 'pending' },
    { ...base, id: '650e8400-e29b-41d4-a716-446655440002', kind: 'operation_request', status: 'answered',
      answer: { text: '', report: 'unable', source: 'tui', answeredAt: now } },
    { ...base, id: '650e8400-e29b-41d4-a716-446655440003', kind: 'approval', status: 'answered', consumedAt: now,
      operation: { toolName: 'Bash', args: '{}', cwd: '/project', argsDigest: 'a'.repeat(64) },
      answer: { text: '', decision: 'allow', scope: 'workspace', source: 'tui', answeredAt: now } },
    { ...base, id: '650e8400-e29b-41d4-a716-446655440004', kind: 'question', status: 'withdrawn', withdrawalReason: '不要です', withdrawnAt: now },
  ].map((record) => GoalQuestionSchema.parse(record));
  goal.questions = records;
  const listed = await listTaktGoalQuestions(input, {});
  expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ questions: records, totalCount: records.length });
  for (const record of records) {
    const result = await getTaktGoalQuestion({ ...input, questionId: record.id }, {});
    expect(JSON.parse(firstTextContent(result.content))).toEqual({ question: record });
  }
});
