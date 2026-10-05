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
});
