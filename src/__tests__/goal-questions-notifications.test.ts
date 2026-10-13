import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { goalRecord } from './helpers/goal-fixtures.js';
import { addGoalQuestion, answerGoalQuestion, assertGoalWorkReady, withdrawGoalQuestion } from '../infra/goals/questions.js';
import { appendGoalNotification, formatGoalNotification } from '../infra/goals/notifications.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { MANAGER_NOTIFICATION_KINDS } from '../core/models/config-types.js';

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
afterEach(() => vi.mocked(crypto.randomUUID).mockReset()
  .mockImplementation(() => '650e8400-e29b-41d4-a716-446655440001'));
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };

describe('saved goal questions', () => {
  it('preserves optional input and refuses an ID collision without changing the first question', () => {
    const original: Goal = goalRecord();
    const input = { body: '形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV', dependentWorkKeys: ['export'] };
    vi.mocked(crypto.randomUUID).mockReturnValue('650e8400-e29b-41d4-a716-446655440001');
    const created = addGoalQuestion(original, input);
    expect(created.goal.questions).toEqual([expect.objectContaining({ ...input, id: created.questionId, status: 'pending', recipient: 'human' })]);
    expect(original.questions).toBeUndefined();
    expect(() => addGoalQuestion(created.goal, { body: '別の質問' })).toThrow();
    expect(created.goal.questions).toHaveLength(1);
  });

  it('blocks only declared work until the same question is answered and records one TUI event', () => {
    const created = addGoalQuestion(goalRecord(), { body: '出力先はどこですか', dependentWorkKeys: ['export'] });
    expect(() => assertGoalWorkReady(created.goal, 'export')).toThrow(created.questionId);
    expect(() => assertGoalWorkReady(created.goal, 'documentation')).not.toThrow();
    expect(() => assertGoalWorkReady(created.goal, undefined)).not.toThrow();
    const answered = answerGoalQuestion(created.goal, created.questionId, ' /tmp/customer export ');
    expect(answered.questions?.[0]).toMatchObject({
      status: 'answered', answer: { text: ' /tmp/customer export ', source: 'tui', answeredAt: expect.any(String) },
    });
    expect(answered.events).toEqual([expect.objectContaining({
      id: expect.any(String), kind: 'answer', questionId: created.questionId, answer: answered.questions?.[0]?.answer, processed: false,
    })]);
    expect(() => assertGoalWorkReady(answered, 'export')).not.toThrow();
    expect(() => answerGoalQuestion(answered, created.questionId, 'again')).toThrow();
    expect(GoalSchema.parse(answered)).toEqual(answered);
    expect(created.goal.questions?.[0]?.status).toBe('pending');
  });

  it('withdraws a pending question without losing its details and releases its dependency', () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか', dependentWorkKeys: ['export'] });
    const withdrawn = withdrawGoalQuestion(created.goal, created.questionId);
    expect(withdrawn.questions?.[0]).toMatchObject({ id: created.questionId, status: 'withdrawn', body: '形式はどれですか' });
    expect(() => assertGoalWorkReady(withdrawn, 'export')).not.toThrow();
    expect(withdrawn.events ?? []).toEqual([]);
    expect(() => withdrawGoalQuestion(withdrawn, created.questionId)).toThrow();
  });

  it('rejects missing questions and blank answers without creating an event', () => {
    const created = addGoalQuestion(goalRecord(), { body: '形式はどれですか' });
    expect(() => answerGoalQuestion(created.goal, created.questionId, ' ')).toThrow();
    expect(() => answerGoalQuestion(created.goal, 'missing', 'JSON')).toThrow();
    expect(() => withdrawGoalQuestion(created.goal, 'missing')).toThrow();
    expect(created.goal.events ?? []).toEqual([]);
  });
});

describe('saved goal notifications', () => {
  it.each(MANAGER_NOTIFICATION_KINDS)('persists and formats %s only when enabled', (kind) => {
    const original: Goal = goalRecord();
    const input = { kind, body: '人への通知', severity: 'warning' as const };
    const saved = appendGoalNotification(original, input, policy);
    expect(saved.notifications).toEqual([{ ...input, id: expect.any(String), recordedAt: expect.any(String) }]);
    expect(original.notifications).toBeUndefined();
    expect(formatGoalNotification(saved, saved.notifications![0]!)).toContain(original.id);
    expect(formatGoalNotification(saved, input)).toContain('warning');
    expect(formatGoalNotification(saved, input)).toContain(input.body);
    expect(appendGoalNotification(original, input, { ...policy, [kind]: false }).notifications).toBeUndefined();
  });

  it('rejects notification ID collisions and formats omitted severity', () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('650e8400-e29b-41d4-a716-446655440001');
    const input = { kind: 'custom' as const, body: '通知' };
    const saved = appendGoalNotification(goalRecord(), input, policy);
    expect(() => appendGoalNotification(saved, input, policy)).toThrow();
    expect(formatGoalNotification(saved, input)).toContain('custom\n通知');
  });
});
