import { beforeEach,expect,it,vi } from 'vitest';
import { getTaktGoalDiff,getTaktGoalHistory,getTaktGoalRelation } from '../features/mcp/goalReadOperations.js';
import { completeGoalInputSchema,goalDiffInputSchema,goalHistoryInputSchema,mergeGoalTaskInputSchema } from '../features/mcp/schemas.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ diff: vi.fn(), history: vi.fn(), relation: vi.fn(), allowed: vi.fn(), get: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/goals/inspection.js', () => ({
  inspectGoalDiff: doubles.diff, inspectGoalHistory: doubles.history, inspectGoalRelation: doubles.relation,
  GOAL_READ_MAX_ITEMS: 50, GOAL_READ_MAX_BYTES: 65536,
}));
vi.mock('../features/mcp/operations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
const workLog = [
  { id: '550e8400-e29b-41d4-a716-446655440003', summary: 'Submitted initial work', recordedAt: '2026-10-13T00:00:00Z' },
  { id: '550e8400-e29b-41d4-a716-446655440004', summary: 'Integrated completed work', recordedAt: '2026-10-13T01:00:00Z' },
];
beforeEach(() => {
  vi.resetAllMocks();
  doubles.diff.mockResolvedValue({ files: [], truncated: false });
  doubles.history.mockResolvedValue({ commits: [], truncated: false });
  doubles.relation.mockResolvedValue({ included: false, ahead: 2 });
  doubles.get.mockResolvedValue({ ...goalRecord(), workLog });
});
it('passes optional selectors and default bounds without a target branch', async () => {
  expect((await getTaktGoalDiff({ ...input, taskName: 'task', file: 'a\tb' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.diff).toHaveBeenCalledWith('/project', input.goalId, 'task', 'a\tb', 50, signal);
  await getTaktGoalHistory({ ...input, limit: 3 }, {}, signal);
  expect(doubles.history).toHaveBeenCalledWith('/project', input.goalId, undefined, 3, signal);
  await getTaktGoalRelation(input, {}, signal);
  expect(doubles.relation).toHaveBeenCalledWith('/project', input.goalId, signal);
});
it.each([0, 51, -1, 1.5])('rejects a history or diff limit of %s', (limit) => {
  expect(goalDiffInputSchema.safeParse({ ...input, limit }).success).toBe(false);
  expect(goalHistoryInputSchema.safeParse({ ...input, limit }).success).toBe(false);
});
it('accepts both count boundaries and rejects authority or target injection', () => {
  for (const limit of [1, 50]) expect(goalHistoryInputSchema.safeParse({ ...input, limit }).success).toBe(true);
  expect(completeGoalInputSchema.safeParse({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence', mainMerge: 'auto' }).success).toBe(false);
  expect(mergeGoalTaskInputSchema.safeParse({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40), targetBranch: 'other' }).success).toBe(false);
});
it('converts inspection and root errors into MCP errors without reporting success', async () => {
  doubles.diff.mockRejectedValue(new Error('missing branch'));
  expect((await getTaktGoalDiff(input, {}, signal)).isError).toBe(true);
  doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });
  doubles.history.mockClear();
  expect((await getTaktGoalHistory(input, {}, signal)).isError).toBe(true);
  expect(doubles.history).not.toHaveBeenCalled();
});
it('does not return oversized serialized metadata as a complete result', async () => {
  doubles.diff.mockResolvedValue({ files: [], patch: 'x'.repeat(65537), truncated: false });
  expect((await getTaktGoalDiff(input, {}, signal)).isError).toBe(true);
});
