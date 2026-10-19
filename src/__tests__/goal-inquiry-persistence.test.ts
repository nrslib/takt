import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { GoalQuestionSchema } from '../infra/goals/schema.js';
import {
  addGoalQuestion, answerGoalQuestion, consumeGoalApproval, isGoalApprovalUsable,
  isSameGoalOperation, withdrawGoalQuestion,
} from '../infra/goals/questions.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), lstat: vi.fn() }));
vi.mock('node:fs', () => ({ readdirSync: vi.fn() }));
vi.mock('../infra/fs/file-lock.js', () => ({ withFileLock: (_path: string, action: () => unknown) => action() }));
vi.mock('../shared/utils/private-file.js', () => ({
  readPrivateFileState: doubles.read, writePrivateFile: doubles.write, ensurePrivateDirectory: vi.fn(),
  capturePrivateDirectoryReadSnapshot: vi.fn(), assertPrivateDirectoryReadSnapshot: vi.fn(),
}));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: doubles.lstat }));

const path = `/project/.takt/goals/${goalId}/goal.json`;
const questionId = '650e8400-e29b-41d4-a716-446655440001';
const now = '2026-10-19T01:00:00.000Z';
const operation = { toolName: 'Bash', args: '{"command":"git status"}', cwd: '/project' };
let files: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  files = new Map();
  doubles.lstat.mockReturnValue({});
  doubles.read.mockImplementation((file: string) => {
    const content = files.get(file);
    return content === undefined ? { state: { exists: false } } : { content: Buffer.from(content) };
  });
  doubles.write.mockImplementation((file: string, content: string) => { files.set(file, content); });
});

describe('inquiry persistence through GoalStore', () => {
  it('reads legacy JSON without kind as questions while retaining answers and only writes explicit kinds on update', async () => {
    const pending = { id: questionId, recipient: 'human', body: '形式はどれですか', status: 'pending' };
    const answered = { ...pending, id: '650e8400-e29b-41d4-a716-446655440002', status: 'answered',
      answer: { text: 'JSON', source: 'tui', answeredAt: now } };
    const withdrawn = { ...pending, id: '650e8400-e29b-41d4-a716-446655440003', status: 'withdrawn' };
    const legacy = JSON.stringify({ ...goalRecord(), questions: [pending, answered, withdrawn] });
    files.set(path, legacy);
    const store = new GoalStore('/project');

    const restored = await store.get(goalId);

    expect(restored.questions).toEqual([pending, answered, withdrawn].map((question) => ({ ...question, kind: 'question' })));
    expect(doubles.write).not.toHaveBeenCalled();
    expect(files.get(path)).toBe(legacy);
    await store.update(goalId, (current) => current);
    expect(JSON.parse(files.get(path)!).questions).toEqual(restored.questions);
  });

  it('writes and restores all three kinds and operation targets', async () => {
    const question = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    const approval = addGoalQuestion(question.goal, { kind: 'approval', body: '操作を許可しますか', operation, targetSha: 'a'.repeat(40) });
    const request = addGoalQuestion(approval.goal, { kind: 'operation_request', body: '認証を更新してください', targetSha: 'b'.repeat(40) });
    const store = new GoalStore('/project');

    await store.create(request.goal);

    expect(JSON.parse(files.get(path)!).questions.map((entry: { kind?: string }) => entry.kind))
      .toEqual(['question', 'approval', 'operation_request']);
    const restored = await store.get(goalId);
    expect(restored.questions).toEqual(request.goal.questions);
    expect(restored.questions?.[1]).toMatchObject({ operation, targetSha: 'a'.repeat(40) });
    expect(restored.questions?.[2]).toMatchObject({ targetSha: 'b'.repeat(40) });
  });

  it.each(['once', 'goal', 'project', 'workspace', 'global'] as const)('retains an allowed decision with %s scope after saving and restoring', async (scope) => {
    const created = addGoalQuestion(goalRecord(), { kind: 'approval', body: '操作を許可しますか', operation });
    const store = new GoalStore('/project');
    await store.create(created.goal);
    await store.update(goalId, (current) => answerGoalQuestion(current, created.questionId, { decision: 'allow', scope }));

    const restored = await store.get(goalId);

    expect(restored.questions?.[0]?.answer).toMatchObject({ text: '', decision: 'allow', scope });
  });

  it('retains a reasonless denial without granting a default scope', async () => {
    const created = addGoalQuestion(goalRecord(), { kind: 'approval', body: '操作を許可しますか', operation });
    const store = new GoalStore('/project');
    await store.create(created.goal);
    await store.update(goalId, (current) => answerGoalQuestion(current, created.questionId, { decision: 'deny' }));

    const restored = await store.get(goalId);

    expect(restored.questions?.[0]?.answer).toMatchObject({ text: '', decision: 'deny' });
    expect(restored.questions?.[0]?.answer?.scope).toBeUndefined();
  });

  it.each(['completed', 'unable'] as const)('retains the structured %s operation report', async (report) => {
    const created = addGoalQuestion(goalRecord(), { kind: 'operation_request', body: '認証を更新してください' });
    const store = new GoalStore('/project');
    await store.create(created.goal);
    await store.update(goalId, (current) => answerGoalQuestion(current, created.questionId, { report }));

    expect((await store.get(goalId)).questions?.[0]?.answer).toMatchObject({ text: '', report });
  });

  it('retains withdrawal reason and time through the existing store update', async () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    const store = new GoalStore('/project');
    await store.create(created.goal);
    const saved = await store.update(goalId, (current) => withdrawGoalQuestion(current, created.questionId, '不要になりました'));

    expect((await store.get(goalId)).questions).toEqual(saved.questions);
    expect(saved.questions?.[0]).toMatchObject({ status: 'withdrawn', withdrawalReason: '不要になりました', withdrawnAt: expect.any(String) });
  });

  it('keeps a consumed approval unusable after saving and restoring the same record', async () => {
    const created = addGoalQuestion(goalRecord(), { kind: 'approval', body: '操作を許可しますか', operation });
    const store = new GoalStore('/project');
    await store.create(created.goal);
    const allowed = await store.update(goalId, (current) => answerGoalQuestion(current, created.questionId, { decision: 'allow' }));
    expect(isGoalApprovalUsable(allowed.questions![0]!)).toBe(true);

    await store.update(goalId, (current) => consumeGoalApproval(current, created.questionId, now));
    const restored = await store.get(goalId);

    expect(restored.questions?.[0]).toMatchObject({ id: created.questionId, consumedAt: now, answer: { decision: 'allow', scope: 'once' } });
    expect(isGoalApprovalUsable(restored.questions![0]!)).toBe(false);
    await expect(store.update(goalId, (current) => consumeGoalApproval(current, created.questionId, now))).rejects.toThrow();
    expect((await store.get(goalId)).questions).toEqual(restored.questions);
  });

  it('preserves operation identity through repeated validation of redacted saved arguments', async () => {
    const input = { kind: 'approval' as const, body: '操作を許可しますか', operation: { ...operation, args: '{"token":"alpha"}' } };
    const created = addGoalQuestion(goalRecord(), input);
    const store = new GoalStore('/project');
    await store.create(created.goal);
    const restored = (await store.get(goalId)).questions![0]!;
    const parsedAgain = GoalQuestionSchema.parse(JSON.parse(JSON.stringify(restored)));
    const same = addGoalQuestion(goalRecord(), input).goal.questions![0]!;
    const different = addGoalQuestion(goalRecord(), { ...input, operation: { ...operation, args: '{"token":"beta"}' } }).goal.questions![0]!;

    expect(restored.operation?.args).toBe('{"token":"[REDACTED]"}');
    expect(isSameGoalOperation(parsedAgain, same)).toBe(true);
    expect(isSameGoalOperation(parsedAgain, different)).toBe(false);
  });
});
