import { describe, expect, it } from 'vitest';
import { GoalQuestionSchema, GoalSchema } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { isGoalPaused, transitionGoalExecution } from '../infra/goals/state.js';

describe('Goal saved record schema', () => {
  it('preserves every required field', () => {
    const record = goalRecord();
    expect(GoalSchema.parse(record)).toEqual(record);
  });

  it.each([
    'id', 'objective', 'outOfScope', 'acceptanceCriteria', 'mode', 'status',
    'branch', 'startBranch', 'integrationBranch', 'constraints', 'workLog',
  ])('rejects a record missing %s', (field) => {
    const record: Record<string, unknown> = goalRecord();
    delete record[field];
    expect(GoalSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    { id: '../outside' },
    { mode: 'github' },
    { objective: '   ' },
    { acceptanceCriteria: 'not an array' },
    { confirmation: { confirmedBy: 'reviewer' } },
    { confirmation: { confirmedAt: 'not a date', confirmedBy: 'reviewer' } },
    { confirmation: { confirmedAt: '2026-10-04T14:43:00.000Z', confirmedBy: '' } },
  ])('rejects invalid saved goal information %#', (invalid) => {
    expect(GoalSchema.safeParse({ ...goalRecord(), ...invalid }).success).toBe(false);
  });

  it('requires stored completion evidence for waiting and completed states', () => {
    const completion = {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main',
      summary: 'criteria and evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      instructions: ['git merge reviewed SHA'],
    };
    expect(GoalSchema.safeParse({ ...goalRecord(), status: 'awaiting_merge' }).success).toBe(false);
    expect(GoalSchema.safeParse({ ...goalRecord(), status: 'awaiting_merge', completion }).success).toBe(true);
    const { changeSummary: _changeSummary, ...withoutChanges } = completion;
    expect(GoalSchema.safeParse({ ...goalRecord(), status: 'awaiting_merge', completion: withoutChanges }).success).toBe(false);
    expect(GoalSchema.safeParse({ ...goalRecord(), status: 'completed', completion }).success).toBe(false);
    expect(GoalSchema.parse({ ...goalRecord(), status: 'completed', completion: { ...completion, targetSha: 'b'.repeat(40) } }).status).toBe('completed');
  });
});

describe('goal execution state and question participants', () => {
  it.each(['active', 'paused', 'aborted'] as const)('identifies paused execution for %s', (executionStatus) => {
    expect(isGoalPaused({ ...goalRecord(), executionStatus })).toBe(executionStatus === 'paused');
  });
  it('preserves awaiting merge evidence through pause and resume on the same goal', async () => {
    const completion = {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'evidence',
      changeSummary: { filesChanged: 1, additions: 2, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      instructions: ['git merge reviewed SHA'],
    };
    const waiting = { ...goalRecord(), status: 'awaiting_merge' as const, executionStatus: 'active' as const, completion };
    const paused = transitionGoalExecution(waiting, 'paused');
    expect(paused).toMatchObject({ id: waiting.id, status: 'awaiting_merge', executionStatus: 'paused', completion });
    const resumed = transitionGoalExecution(paused, 'active');
    expect(resumed).toEqual(waiting);
  });

  it.each(['active', 'paused'] as const)('permits abort from %s and rejects subsequent resume', async (executionStatus) => {
    const aborted = transitionGoalExecution({ ...goalRecord(), executionStatus }, 'aborted');
    expect(aborted).toMatchObject({ status: 'created', executionStatus: 'aborted' });
    expect(() => transitionGoalExecution(aborted, 'active')).toThrow();
    expect(() => transitionGoalExecution(aborted, 'paused')).toThrow();
  });

  it.each(['active', 'paused', 'aborted'] as const)('rejects abort of a completed %s goal except for an already aborted retry', (executionStatus) => {
    const completed = GoalSchema.parse({
      ...goalRecord(), status: 'completed', executionStatus,
      completion: {
        goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
        summary: 'Completion evidence',
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
        instructions: ['git merge reviewed SHA'],
      },
    });
    const before = structuredClone(completed);
    if (executionStatus === 'aborted') expect(transitionGoalExecution(completed, 'aborted')).toEqual(before);
    else expect(() => transitionGoalExecution(completed, 'aborted')).toThrow(/completed/iu);
    expect(completed).toEqual(before);
  });

  it.each(['active', 'paused', 'aborted'])('represents %s execution independently of awaiting merge progress', (executionStatus) => {
    const completion = {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'evidence',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      instructions: ['git merge reviewed SHA'],
    };
    const record = { ...goalRecord(), status: 'awaiting_merge', executionStatus, completion };
    expect(GoalSchema.parse(record)).toEqual(record);
  });

  it.each([0, -1, 1.5])('rejects invalid acceptance criteria version %s', (acceptanceCriteriaVersion) => {
    expect(GoalSchema.safeParse({ ...goalRecord(), acceptanceCriteriaVersion }).success).toBe(false);
  });

  it.each(['human'])('preserves the %s question recipient', (recipient) => {
    const question = { id: '650e8400-e29b-41d4-a716-446655440001', body: 'Which format?', status: 'pending', recipient };
    expect(GoalQuestionSchema.parse(question)).toEqual(question);
  });

  it.each(['tui', 'slack'])('preserves an answer from %s', (source) => {
    const question = { id: '650e8400-e29b-41d4-a716-446655440001', body: 'Which format?', status: 'answered', recipient: 'human',
      answer: { source, text: 'JSON', answeredAt: '2026-10-08T00:00:00Z' } };
    expect(GoalQuestionSchema.parse(question)).toEqual(question);
  });

  it.each([
    { creationOrigin: 'director' },
    { confirmation: { confirmedAt: '2026-10-08T00:00:00Z', confirmedBy: 'human' } },
    { decisions: [] },
    { events: [{ id: 'event', kind: 'delegation_completion', requestId: 'r', result: {}, evidenceRefs: [], processed: false }] },
    { questions: [{ id: '650e8400-e29b-41d4-a716-446655440001', body: 'question', recipient: 'director', status: 'pending' }] },
  ])('rejects removed goal fields %#', (fields) => {
    expect(GoalSchema.safeParse({ ...goalRecord(), ...fields }).success).toBe(false);
  });
});
