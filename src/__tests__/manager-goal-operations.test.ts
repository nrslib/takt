import { beforeEach,expect,it,vi } from 'vitest';
import { enqueueTaktGoalTask } from '../features/mcp/goalOperations.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), states: vi.fn(), tasks: vi.fn(), enqueue: vi.fn(), workflow: vi.fn(), ensure: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.states; listAllTaskItems = doubles.tasks; } }));
vi.mock('../infra/task/enqueueService.js', () => ({ enqueueTask: doubles.enqueue }));
vi.mock('../features/mcp/goalWorkflowValidation.js', () => ({ validateGoalWorkflow: doubles.workflow, GoalWorkflowNotAllowedError: class extends Error {} }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../features/manager/notifications.js', () => ({ resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }), sendSavedGoalNotifications: vi.fn() }));
vi.mock('../features/mcp/operations.js', async (original) => ({ ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: vi.fn() }));
let goal: Goal;
const input = { cwd: '/project', goalId: goalRecord().id, purpose: 'CSVを実装する', task: 'CSVを実装する', workflow: 'safe', workKey: 'csv' };
const signal = new AbortController().signal;
beforeEach(() => { vi.resetAllMocks(); goal = goalRecord(); doubles.get.mockImplementation(async () => goal); doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => { goal = transform(goal); return goal; }); doubles.states.mockReturnValue([]); doubles.enqueue.mockResolvedValue({ taskName: 'task-a', tasksFile: '/project/.takt/tasks.yaml', workflow: 'safe' }); });
it('submits isolated goal work and records its purpose in the shared memory', async () => {
  expect((await enqueueTaktGoalTask(input, {}, signal)).isError).toBeUndefined();
  expect(doubles.enqueue).toHaveBeenCalledWith(expect.objectContaining({ goalId: goal.id, goalPurpose: input.purpose, goalWorkKey: 'csv', worktree: true, autoPr: false, shouldPublishBranchToOrigin: false, taskContext: { baseBranch: goal.branch }, abortSignal: signal }), expect.any(Function));
  expect(goal.workLog).toHaveLength(1); expect(goal).not.toHaveProperty('operations'); expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
});
it('finds a previously submitted work key in tasks.yaml and leaves it unchanged', async () => {
  doubles.states.mockReturnValue([{ name: 'task-a', goalId: goal.id, goalWorkKey: 'csv', status: 'completed', workflow: 'safe' }]);
  expect((await enqueueTaktGoalTask(input, {}, signal)).isError).toBeUndefined();
  expect(doubles.enqueue).not.toHaveBeenCalled(); expect(doubles.update).not.toHaveBeenCalled();
});
it('lets the manager decide which work can proceed while a question is pending', async () => {
  goal.questions = [{ id: '550e8400-e29b-41d4-a716-446655440001', recipient: 'human', body: '確認', status: 'pending' }];
  expect((await enqueueTaktGoalTask(input, {}, signal)).isError).toBeUndefined(); expect(doubles.enqueue).toHaveBeenCalledOnce();
});
it('rejects a prohibited workflow before enqueueing', async () => {
  doubles.workflow.mockImplementation(() => { throw new Error('prohibited workflow'); });
  expect((await enqueueTaktGoalTask(input, {}, signal)).isError).toBe(true); expect(doubles.enqueue).not.toHaveBeenCalled();
});
it.each(['paused', 'aborted'] as const)('does not enqueue work for a %s goal', async (executionStatus) => {
  goal.executionStatus = executionStatus;
  expect((await enqueueTaktGoalTask(input, {}, signal)).isError).toBe(true); expect(doubles.enqueue).not.toHaveBeenCalled();
});

it.each([true, false])('checks canonical instructions before reusing work without a key (same instructions: %s)', async (same) => {
  doubles.states.mockReturnValue([{ name: 'task-a', goalId: goal.id, goalPurpose: input.purpose, workflow: input.workflow }]);
  doubles.tasks.mockReturnValue([{ name: 'task-a', content: same ? input.task : '別の指示' }]);
  expect((await enqueueTaktGoalTask({ ...input, workKey: undefined }, {}, signal)).isError).toBeUndefined();
  expect(doubles.enqueue).toHaveBeenCalledTimes(same ? 0 : 1);
});

it('reads task instructions once when checking multiple candidates without a work key', async () => {
  doubles.states.mockReturnValue(['task-a', 'task-b'].map((name) => ({
    name, goalId: goal.id, goalPurpose: input.purpose, workflow: input.workflow,
  })));
  doubles.tasks.mockReturnValue([
    { name: 'task-a', content: '別の指示' }, { name: 'task-b', content: input.task },
  ]);

  const result = await enqueueTaktGoalTask({ ...input, workKey: undefined }, {}, signal);

  expect(result.isError).toBeUndefined();
  expect(doubles.tasks).toHaveBeenCalledOnce();
  expect(doubles.enqueue).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
});
