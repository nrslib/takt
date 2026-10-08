import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({
  get: vi.fn(), lock: vi.fn(), merge: vi.fn(), complete: vi.fn(), check: vi.fn(),
  project: vi.fn(), resolve: vi.fn(), allowed: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: doubles.lock }));
vi.mock('../infra/goals/integration.js', () => ({
  integrateGoalTask: doubles.merge, completeGoal: doubles.complete, checkGoalCompletion: doubles.check,
}));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.project }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.resolve }));
vi.mock('../features/mcp/operations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
import { checkTaktGoalCompletion, completeTaktGoal, mergeTaktGoalTask, resolveGoalIntegrationConfig } from '../features/mcp/goalIntegrationOperations.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  doubles.get.mockResolvedValue(goalRecord());
  doubles.project.mockReturnValue({ mainMerge: 'approve' });
  doubles.resolve.mockReturnValue(undefined);
  doubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action());
  doubles.merge.mockResolvedValue({ status: 'merged', sha: 'a'.repeat(40), recorded: true });
  doubles.complete.mockResolvedValue({ recorded: true });
  doubles.check.mockResolvedValue({ included: true, recorded: true });
});
it('resolves permission only from project configuration and target from the existing base branch', async () => {
  expect(await resolveGoalIntegrationConfig(input.cwd, input.goalId)).toEqual({ mainMerge: 'approve', targetBranch: 'main' });
  doubles.project.mockReturnValue({ mainMerge: 'auto' });
  doubles.resolve.mockReturnValue('release');
  expect(await resolveGoalIntegrationConfig(input.cwd, input.goalId)).toEqual({ mainMerge: 'auto', targetBranch: 'release' });
});
it('passes delegated goal ownership and cancellation through every write operation', async () => {
  const deps = { goalTurnOwners: { [input.goalId]: 'owner' } };
  await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, deps, signal);
  await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, deps, signal);
  await checkTaktGoalCompletion(input, deps, signal);
  expect(doubles.lock.mock.calls).toHaveLength(3);
  for (const call of doubles.lock.mock.calls) {
    expect(call[0]).toBe(input.cwd); expect(call[1]).toEqual([input.goalId]);
    expect(call[3]).toBe(deps.goalTurnOwners); expect(call[4]).toBe(signal);
  }
  expect(doubles.complete).toHaveBeenCalledWith(input.cwd, input.goalId, 'a'.repeat(40), 'evidence', 'approve', 'main', signal);
  expect(doubles.check).toHaveBeenCalledWith(input.cwd, input.goalId, signal);
});
it('returns structured partial success as a tool error after saving fails', async () => {
  doubles.merge.mockResolvedValue({ status: 'merged', sha: 'b'.repeat(40), recorded: false, recordError: 'failure' });
  const result = await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ status: 'merged', sha: 'b'.repeat(40), recorded: false, recordError: 'failure' }) }]);
});
it('does not enter the goal lock after root validation fails', async () => {
  doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });
  expect((await checkTaktGoalCompletion(input, {}, signal)).isError).toBe(true);
  expect(doubles.lock).not.toHaveBeenCalled();
});
