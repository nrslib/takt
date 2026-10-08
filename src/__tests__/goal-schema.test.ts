import { describe, expect, it } from 'vitest';
import { GoalSchema } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

describe('Goal saved record schema', () => {
  it.each(['human', 'director'] as const)('preserves every required field for %s creation', (creationOrigin) => {
    const record = { ...goalRecord(), creationOrigin };
    expect(GoalSchema.parse(record)).toEqual(record);
  });

  it.each([
    'id', 'objective', 'outOfScope', 'acceptanceCriteria', 'mode', 'status',
    'branch', 'startBranch', 'integrationBranch', 'creationOrigin', 'confirmation',
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
