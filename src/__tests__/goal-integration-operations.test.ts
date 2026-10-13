import { beforeEach,expect,it,vi } from 'vitest';
import { checkTaktGoalCompletion,completeTaktGoal,mergeTaktGoalTask } from '../features/mcp/goalIntegrationOperations.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), merge: vi.fn(), complete: vi.fn(), check: vi.fn(), config: vi.fn(), resolve: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/goals/integration.js', () => ({ integrateGoalTask: doubles.merge, completeGoal: doubles.complete, checkGoalCompletion: doubles.check }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.resolve }));
vi.mock('../features/mcp/operations.js', async (original) => ({ ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: vi.fn() }));
vi.mock('../features/manager/notifications.js', () => ({ resolveManagerNotificationOptions: doubles.config, sendSavedGoalNotifications: vi.fn() }));
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const input = { cwd: '/project', goalId: goalRecord().id };
const signal = new AbortController().signal;
beforeEach(() => { vi.resetAllMocks(); doubles.get.mockResolvedValue(goalRecord()); doubles.config.mockReturnValue({ mainMerge: 'approve', policy }); doubles.resolve.mockReturnValue('ja'); doubles.merge.mockResolvedValue({ status: 'merged' }); doubles.complete.mockResolvedValue({ status: 'awaiting_merge' }); doubles.check.mockResolvedValue({ included: true }); });
it.each(['paused', 'aborted'] as const)('rejects writes against a %s goal before invoking tools', async (executionStatus) => {
  doubles.get.mockResolvedValue({ ...goalRecord(), executionStatus });
  for (const result of [await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal), await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal), await checkTaktGoalCompletion(input, {}, signal)]) expect(result.isError).toBe(true);
  expect(doubles.merge).not.toHaveBeenCalled(); expect(doubles.complete).not.toHaveBeenCalled(); expect(doubles.check).not.toHaveBeenCalled();
});
it('passes reviewed SHA, notification policy and cancellation directly to integration', async () => {
  await mergeTaktGoalTask({ ...input, taskName: 'task', expectedSha: 'a'.repeat(40) }, {}, signal);
  expect(doubles.merge).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, 'task', 'a'.repeat(40), signal, policy, 'ja');
});
it.each(['auto', 'approve'] as const)('uses the configured %s completion policy', async (mainMerge) => {
  doubles.config.mockReturnValue({ mainMerge, policy });
  await completeTaktGoal({ ...input, expectedSha: 'a'.repeat(40), summary: 'evidence' }, {}, signal);
  expect(doubles.complete).toHaveBeenCalledExactlyOnceWith(input.cwd, input.goalId, 'a'.repeat(40), 'evidence', mainMerge, signal, policy);
});
