import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import { GoalSchema, type Goal, type GoalQuestion } from '../infra/goals/schema.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), remove: vi.fn(), saveEvent: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/events.js', () => ({ deleteGoalEvents: doubles.remove, saveManagerEvent: doubles.saveEvent }));

const now = '2026-10-19T01:00:00.000Z';
const later = '2026-10-19T02:00:00.000Z';
const questionId = '650e8400-e29b-41d4-a716-446655440001';
const signal = new AbortController().signal;
let stored: Goal;

function pending(id: string): GoalQuestion {
  return { id, recipient: 'human', body: '形式はどれですか', status: 'pending' };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  stored = { ...goalRecord(), questions: [pending(questionId)] };
  doubles.get.mockImplementation(async () => structuredClone(stored));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    const next = GoalSchema.parse(transform(structuredClone(stored)));
    stored = next;
    return structuredClone(next);
  });
});
afterEach(() => vi.useRealTimers());

describe('goal execution inquiry lifecycle', () => {
  it('closes existing pending inquiries when the same goal is aborted and preserves closed inquiries', async () => {
    const answered: GoalQuestion = { ...pending('650e8400-e29b-41d4-a716-446655440002'), status: 'answered',
      answer: { text: 'JSON', source: 'tui', answeredAt: now } };
    const withdrawn = { ...pending('650e8400-e29b-41d4-a716-446655440003'), status: 'withdrawn' as const };
    stored = GoalSchema.parse({ ...stored, questions: [...stored.questions!, answered, withdrawn] });
    const before = structuredClone(stored);
    expect(before.questions?.[0]?.status).toBe('pending');
    doubles.remove.mockImplementation(() => {
      expect(stored.executionStatus).toBe('aborted');
      expect(stored.questions?.[0]?.status).toBe('withdrawn');
    });

    const result = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);

    expect(result.id).toBe(before.id);
    expect(result.executionStatus).toBe('aborted');
    expect(result.questions?.[0]).toMatchObject({ id: questionId, status: 'withdrawn', withdrawnAt: now });
    expect(result.questions?.[0]?.withdrawalReason?.trim().length).toBeGreaterThan(0);
    expect(result.questions?.slice(1)).toEqual(before.questions?.slice(1));
    expect(stored).toEqual(result);
    expect(doubles.update).toHaveBeenCalledOnce();
    expect(doubles.remove).toHaveBeenCalledExactlyOnceWith('/project', goalId);
    expect(doubles.saveEvent).not.toHaveBeenCalled();
  });

  it('closes inquiries added after the preliminary read and preserves answers from the current update record', async () => {
    const previous = structuredClone(stored);
    doubles.get.mockImplementationOnce(async () => {
      stored = { ...stored, questions: [
        { ...pending(questionId), status: 'answered', answer: { text: 'CSV', source: 'tui', answeredAt: now } },
        pending('650e8400-e29b-41d4-a716-446655440002'),
      ] };
      return previous;
    });

    const result = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);

    expect(result.questions).toEqual([
      expect.objectContaining({ id: questionId, status: 'answered', answer: { text: 'CSV', source: 'tui', answeredAt: now } }),
      expect.objectContaining({ id: '650e8400-e29b-41d4-a716-446655440002', status: 'withdrawn', withdrawnAt: now, withdrawalReason: expect.any(String) }),
    ]);
  });

  it('keeps the same pending inquiry through pause and resume, then closes it on abort', async () => {
    stored = GoalSchema.parse(stored);
    const original = structuredClone(stored);

    const paused = await setGoalExecutionStatus('/project', goalId, 'paused', signal);
    expect(paused.executionStatus).toBe('paused');
    expect(paused.questions).toEqual(original.questions);
    expect(doubles.remove).not.toHaveBeenCalled();
    expect(doubles.saveEvent).not.toHaveBeenCalled();

    const resumed = await setGoalExecutionStatus('/project', goalId, 'active', signal);
    expect(resumed.id).toBe(original.id);
    expect(resumed.questions).toEqual(original.questions);
    expect(doubles.saveEvent).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'resumed', goalId });

    const aborted = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);
    expect(aborted.questions?.[0]).toMatchObject({ id: questionId, status: 'withdrawn', withdrawnAt: now });
    expect(aborted.questions?.[0]?.withdrawalReason?.trim().length).toBeGreaterThan(0);
  });

  it('does not overwrite the original withdrawal when abort is retried', async () => {
    const first = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);
    vi.setSystemTime(later);
    const retried = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);
    expect(first.questions?.[0]).toMatchObject({ status: 'withdrawn', withdrawnAt: now });
    expect(retried.questions).toEqual(first.questions);
  });

  it('refuses to abort a completed goal without changing inquiries or deleting events', async () => {
    stored = GoalSchema.parse({ ...stored, status: 'completed', completion: {
      goalBranch: stored.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      summary: '完了確認済み', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } });
    const before = structuredClone(stored);

    await expect(setGoalExecutionStatus('/project', goalId, 'aborted', signal)).rejects.toThrow();

    expect(stored).toEqual(before);
    expect(doubles.remove).not.toHaveBeenCalled();
    expect(doubles.saveEvent).not.toHaveBeenCalled();
  });

  it.each(['active', 'paused'] as const)('refuses %s after abort without reviving inquiries', async (status) => {
    await setGoalExecutionStatus('/project', goalId, 'aborted', signal);
    const before = structuredClone(stored);
    doubles.remove.mockClear();
    await expect(setGoalExecutionStatus('/project', goalId, status, signal)).rejects.toThrow();
    expect(stored).toEqual(before);
    expect(doubles.remove).not.toHaveBeenCalled();
    expect(doubles.saveEvent).not.toHaveBeenCalled();
  });

  it('keeps pending inquiries and events when saving the abort fails, then closes them on retry', async () => {
    const before = structuredClone(stored);
    doubles.update.mockImplementationOnce(async (_id: string, transform: (current: Goal) => Goal) => {
      transform(structuredClone(stored));
      throw new Error('保存に失敗しました');
    });

    await expect(setGoalExecutionStatus('/project', goalId, 'aborted', signal)).rejects.toThrow();

    expect(stored).toEqual(before);
    expect(doubles.remove).not.toHaveBeenCalled();
    const retried = await setGoalExecutionStatus('/project', goalId, 'aborted', signal);
    expect(retried.questions?.[0]).toMatchObject({ id: questionId, status: 'withdrawn', withdrawnAt: now });
    expect(doubles.remove).toHaveBeenCalledOnce();
  });

  it('does not save or remove events when cancellation occurs before the update', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = structuredClone(stored);

    await expect(setGoalExecutionStatus('/project', goalId, 'aborted', controller.signal)).rejects.toThrow();

    expect(stored).toEqual(before);
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.remove).not.toHaveBeenCalled();
    expect(doubles.saveEvent).not.toHaveBeenCalled();
  });
});
