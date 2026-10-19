import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addGoalQuestion, answerGoalQuestion, consumeGoalApproval, isGoalApprovalUsable,
  isSameGoalOperation, withdrawGoalQuestion, withdrawPendingGoalQuestions,
} from '../infra/goals/questions.js';
import { GoalQuestionSchema, type Goal, type GoalQuestion } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const now = '2026-10-19T01:00:00.000Z';
const later = '2026-10-19T02:00:00.000Z';
const operation = { toolName: 'Bash', args: '{"command":"git status"}', cwd: '/project' };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

function approval(overrides: Partial<typeof operation> = {}, targetSha = 'a'.repeat(40)) {
  return addGoalQuestion(goalRecord(), {
    kind: 'approval', body: 'この操作を許可しますか', operation: { ...operation, ...overrides }, targetSha,
  });
}

function inquiry(goal: Goal, id: string): GoalQuestion {
  const found = goal.questions?.find((question) => question.id === id);
  if (found === undefined) throw new Error('テスト対象の問い合わせがありません');
  return found;
}

describe('inquiry creation and operation identity', () => {
  it.each(['question', 'approval', 'operation_request'] as const)('creates an explicit %s kind without changing the input goal', (kind) => {
    const original = goalRecord();
    const before = structuredClone(original);
    const created = addGoalQuestion(original, { kind, body: '確認してください', ...(kind === 'approval' ? { operation } : {}) });
    expect(inquiry(created.goal, created.questionId)).toMatchObject({ kind, status: 'pending', createdAt: now });
    expect(original).toEqual(before);
  });

  it('defaults the existing question call to an explicit question kind', () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    expect(inquiry(created.goal, created.questionId)).toMatchObject({ kind: 'question' });
  });

  it('identifies the same operation after parsing saved data', () => {
    const saved = approval();
    const restored = GoalQuestionSchema.parse(JSON.parse(JSON.stringify(inquiry(saved.goal, saved.questionId))));
    const fresh = approval();
    expect(isSameGoalOperation(restored, inquiry(fresh.goal, fresh.questionId))).toBe(true);
  });

  it.each([
    { toolName: 'Write' }, { args: '{"command":"git diff"}' }, { cwd: '/other-project' },
  ])('distinguishes a changed operation field %j', (change) => {
    const original = approval();
    const changed = approval(change);
    expect(isSameGoalOperation(inquiry(original.goal, original.questionId), inquiry(changed.goal, changed.questionId))).toBe(false);
  });

  it('distinguishes a changed target SHA', () => {
    const original = approval();
    const changed = approval({}, 'b'.repeat(40));
    expect(isSameGoalOperation(inquiry(original.goal, original.questionId), inquiry(changed.goal, changed.questionId))).toBe(false);
  });

  it('distinguishes different arguments even when their saved redactions are equal', () => {
    const first = approval({ args: '{"token":"alpha"}' });
    const second = approval({ args: '{"token":"beta"}' });
    const left = inquiry(first.goal, first.questionId);
    const right = inquiry(second.goal, second.questionId);
    expect(left.operation?.args).toBe('{"token":"[REDACTED]"}');
    expect(right.operation?.args).toBe(left.operation?.args);
    expect(isSameGoalOperation(left, right)).toBe(false);
  });

  it.each(['toolName', 'args', 'cwd'] as const)('rejects approval without %s', (field) => {
    const created = approval();
    const question = inquiry(created.goal, created.questionId);
    const incomplete: Record<string, unknown> = { ...question.operation };
    delete incomplete[field];
    expect(GoalQuestionSchema.safeParse({
      ...question, operation: incomplete,
    }).success).toBe(false);
  });
});

describe('structured inquiry answers', () => {
  it.each(['allow', 'deny'] as const)('records %s without a comment while keeping answer text a string', (decision) => {
    const created = approval();
    const answered = answerGoalQuestion(created.goal, created.questionId, { decision });
    expect(inquiry(answered, created.questionId)).toMatchObject({
      status: 'answered', answer: { text: '', decision, source: 'tui', answeredAt: now },
    });
    expect(inquiry(answered, created.questionId).answer?.scope).toBe(decision === 'allow' ? 'once' : undefined);
    expect(inquiry(created.goal, created.questionId).status).toBe('pending');
  });

  it.each(['OK', { text: 'OK' }])('rejects approval comments without an explicit decision: %j', (answer) => {
    const created = approval();
    const before = structuredClone(created.goal);
    expect(() => answerGoalQuestion(created.goal, created.questionId, answer)).toThrow();
    expect(created.goal).toEqual(before);
  });

  it('keeps an explicit approval scope and comment', () => {
    const created = approval();
    const answered = answerGoalQuestion(created.goal, created.questionId, { decision: 'allow', scope: 'project', text: '確認済みです' });
    expect(inquiry(answered, created.questionId).answer).toMatchObject({ decision: 'allow', scope: 'project', text: '確認済みです' });
  });

  it.each([
    { text: 'OK' }, { decision: 'maybe', text: '' }, { decision: 'allow', scope: 'session', text: '' },
  ])('rejects invalid saved approval answers %j', (answer) => {
    const created = approval();
    expect(GoalQuestionSchema.safeParse({
      ...inquiry(created.goal, created.questionId), status: 'answered',
      answer: { ...answer, source: 'tui', answeredAt: now },
    }).success).toBe(false);
  });

  it.each(['completed', 'unable'] as const)('records an operation report of %s without a comment', (report) => {
    const created = addGoalQuestion(goalRecord(), { kind: 'operation_request', body: '認証を更新してください' });
    const answered = answerGoalQuestion(created.goal, created.questionId, { report });
    expect(inquiry(answered, created.questionId)).toMatchObject({ status: 'answered', answer: { text: '', report } });
  });

  it('does not infer an operation report from free text', () => {
    const created = addGoalQuestion(goalRecord(), { kind: 'operation_request', body: '認証を更新してください' });
    expect(() => answerGoalQuestion(created.goal, created.questionId, '実施しました')).toThrow();
  });

  it('rejects an unknown report in a saved operation request', () => {
    const created = addGoalQuestion(goalRecord(), { kind: 'operation_request', body: '認証を更新してください' });
    expect(GoalQuestionSchema.safeParse({
      ...inquiry(created.goal, created.questionId), status: 'answered',
      answer: { text: '', report: 'unknown', source: 'tui', answeredAt: now },
    }).success).toBe(false);
  });

  it.each(['自由文の回答', 'JSON'])('preserves the legacy question answer %s without granting a scope', (text) => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか', options: ['CSV', 'JSON'] });
    const answered = answerGoalQuestion(created.goal, created.questionId, text);
    expect(inquiry(answered, created.questionId).answer).toEqual({ text, source: 'tui', answeredAt: now });
  });
});

describe('withdrawal and approval consumption', () => {
  it('records a withdrawal reason and time and preserves them on a repeated withdrawal', () => {
    const created = approval();
    const withdrawn = withdrawGoalQuestion(created.goal, created.questionId, '操作が不要になりました');
    expect(inquiry(withdrawn, created.questionId)).toMatchObject({
      status: 'withdrawn', withdrawalReason: '操作が不要になりました', withdrawnAt: now,
    });
    vi.setSystemTime(later);
    expect(withdrawGoalQuestion(withdrawn, created.questionId, '別の理由')).toEqual(withdrawn);
    expect(inquiry(created.goal, created.questionId).status).toBe('pending');
  });

  it('keeps the existing reasonless withdrawal call valid', () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    expect(inquiry(withdrawGoalQuestion(created.goal, created.questionId), created.questionId)).toMatchObject({
      status: 'withdrawn', withdrawnAt: now,
    });
  });

  it('withdraws only pending inquiries with the supplied reason and time without mutating the goal', () => {
    let goal: Goal = goalRecord();
    const pendingIds: string[] = [];
    for (const kind of ['question', 'approval', 'operation_request'] as const) {
      const created = addGoalQuestion(goal, { kind, body: '確認してください', ...(kind === 'approval' ? { operation } : {}) });
      goal = created.goal;
      pendingIds.push(created.questionId);
    }
    const answered = addGoalQuestion(goal, { body: '回答済みの質問' });
    goal = answerGoalQuestion(answered.goal, answered.questionId, 'JSON');
    const withdrawn = addGoalQuestion(goal, { body: '取り下げ済みの質問' });
    goal = withdrawGoalQuestion(withdrawn.goal, withdrawn.questionId, '元の理由');
    const before = structuredClone(goal);
    vi.setSystemTime(later);

    const closed = withdrawPendingGoalQuestions(goal, 'ゴールを中止しました', now);

    for (const id of pendingIds) expect(inquiry(closed, id)).toMatchObject({
      status: 'withdrawn', withdrawalReason: 'ゴールを中止しました', withdrawnAt: now,
    });
    expect(inquiry(closed, answered.questionId)).toEqual(inquiry(before, answered.questionId));
    expect(inquiry(closed, withdrawn.questionId)).toEqual(inquiry(before, withdrawn.questionId));
    expect(goal).toEqual(before);
    expect(withdrawPendingGoalQuestions(closed, '再実行', later)).toEqual(closed);
  });

  it('accepts a goal without inquiries in bulk withdrawal', () => {
    expect(withdrawPendingGoalQuestions(goalRecord(), 'ゴールを中止しました', now)).toEqual(goalRecord());
  });

  it.each(['once', 'global'] as const)('consumes a %s approval exactly once', (scope) => {
    const created = approval();
    const allowed = answerGoalQuestion(created.goal, created.questionId, { decision: 'allow', scope });
    expect(isGoalApprovalUsable(inquiry(allowed, created.questionId))).toBe(true);
    const before = structuredClone(allowed);

    const consumed = consumeGoalApproval(allowed, created.questionId, now);

    expect(inquiry(consumed, created.questionId).consumedAt).toBe(now);
    expect(isGoalApprovalUsable(inquiry(consumed, created.questionId))).toBe(false);
    expect(() => consumeGoalApproval(consumed, created.questionId, later)).toThrow();
    expect(allowed).toEqual(before);
  });

  it.each(['pending', 'denied', 'withdrawn', 'question', 'operation_request'] as const)('does not use or consume a %s inquiry as approval', (state) => {
    const created = state === 'question' || state === 'operation_request'
      ? addGoalQuestion(goalRecord(), { kind: state, body: '確認してください' }) : approval();
    let goal = created.goal;
    if (state === 'denied') goal = answerGoalQuestion(goal, created.questionId, { decision: 'deny' });
    if (state === 'withdrawn') goal = withdrawGoalQuestion(goal, created.questionId);
    if (state === 'question') goal = answerGoalQuestion(goal, created.questionId, 'OK');
    if (state === 'operation_request') goal = answerGoalQuestion(goal, created.questionId, { report: 'completed' });
    const before = structuredClone(goal);
    expect(isGoalApprovalUsable(inquiry(goal, created.questionId))).toBe(false);
    expect(() => consumeGoalApproval(goal, created.questionId, now)).toThrow();
    expect(goal).toEqual(before);
  });
});
