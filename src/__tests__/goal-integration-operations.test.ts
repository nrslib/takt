import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({
  get: vi.fn(), lock: vi.fn(), merge: vi.fn(), complete: vi.fn(), check: vi.fn(),
  project: vi.fn(), resolve: vi.fn(), allowed: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: doubles.lock }));
vi.mock('../infra/goals/integration.js', () => ({
  integrateGoalTask: doubles.merge, completeGoal: doubles.complete, checkGoalCompletion: doubles.check,
}));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.project }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.resolve }));
vi.mock('../features/mcp/operations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));
import { checkTaktGoalCompletion, completeTaktGoal, mergeTaktGoalTask } from '../features/mcp/goalIntegrationOperations.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { prepareGoalOperation } from '../infra/goals/operations.js';
const notifications = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  doubles.get.mockResolvedValue(goalRecord());
  doubles.project.mockReturnValue({ mainMerge: 'approve', notifications });
  doubles.resolve.mockReturnValue('ja');
  doubles.lock.mockImplementation(async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action());
  doubles.merge.mockResolvedValue({ status: 'merged', sha: 'a'.repeat(40), recorded: true });
  doubles.complete.mockResolvedValue({ recorded: true });
  doubles.check.mockResolvedValue({ included: true, recorded: true });
});

it.each(['merge', 'complete', 'check'] as const)('rejects paused goal %s after rereading under the lock without starting integration', async (operation) => {
  doubles.get.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused' });
  doubles.get.mockResolvedValueOnce(goalRecord());
  const result = operation === 'merge'
    ? await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal)
    : operation === 'complete'
      ? await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal)
      : await checkTaktGoalCompletion(input, {}, signal);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/paused|一時停止/iu);
  expect(doubles.merge).not.toHaveBeenCalled();
  expect(doubles.complete).not.toHaveBeenCalled();
  expect(doubles.check).not.toHaveBeenCalled();
});

it('rejects a completed operation replay while paused and reuses its saved result after activation', async () => {
  const goal = { ...goalRecord(), events: [{ id: 'event-a', kind: 'completion' as const, taskName: 'task-a', runSlug: 'run-a',
    result: { success: true, interrupted: false }, processed: false }] };
  const context = { goalId: goal.id, eventId: 'event-a' };
  const operation = prepareGoalOperation(goal, context, 'complete:verified', 'complete', { expectedSha: 'a'.repeat(40), summary: 'evidence' });
  const saved = { ...goal, executionStatus: 'paused' as const,
    operations: [{ ...operation, status: 'completed' as const, result: { status: 'awaiting_merge', recorded: true } }] };
  doubles.get.mockResolvedValue(saved);
  const request = { ...input, operationName: operation.operationName, expectedSha: 'a'.repeat(40), summary: 'evidence' };
  const denied = await completeTaktGoal(request, { goalEventContext: context }, signal);
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toMatch(/paused|一時停止/iu);
  expect(doubles.complete).not.toHaveBeenCalled();
  doubles.get.mockResolvedValue({ ...saved, executionStatus: 'active' });
  const replay = await completeTaktGoal(request, { goalEventContext: context }, signal);
  expect(replay.isError).toBeUndefined();
  expect(replay.content).toEqual([{ type: 'text', text: JSON.stringify(saved.operations[0]!.result) }]);
  expect(doubles.complete).not.toHaveBeenCalled();
});
it.each(['auto', 'approve'] as const)('resolves %s permission without passing a configured target branch', async (mainMerge) => {
  doubles.project.mockReturnValue({ mainMerge, notifications });
  doubles.get.mockResolvedValue({ ...goalRecord(), integrationBranch: 'release' });
  doubles.resolve.mockReturnValue('develop');
  await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal);
  expect(doubles.complete).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, 'a'.repeat(40), 'evidence', mainMerge, signal, notifications, undefined);
  expect(doubles.resolve).not.toHaveBeenCalled();
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
  expect(doubles.complete).toHaveBeenCalledWith(input.cwd, input.goalId, 'a'.repeat(40), 'evidence', 'approve', signal, notifications, undefined);
  expect(doubles.check).toHaveBeenCalledWith(input.cwd, input.goalId, signal, notifications, undefined);
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

it.each(['ja', 'en'] as const)('passes the configured %s language to task integration', async (language) => {
  doubles.resolve.mockReturnValue(language);
  await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal);
  expect(doubles.resolve).toHaveBeenCalledExactlyOnceWith(input.cwd, 'language');
  expect(doubles.merge).toHaveBeenCalledExactlyOnceWith(
    input.cwd, input.goalId, 'task', 'a'.repeat(40), signal, notifications, language, undefined,
  );
});
