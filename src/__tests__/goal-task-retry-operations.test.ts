import { beforeEach,expect,it,vi } from 'vitest';
import { removeTaktGoalTask } from '../features/mcp/goalTaskRemovalOperations.js';
import { requeueTaktGoalTask,retryTaktGoalTask } from '../features/mcp/goalTaskRetryOperations.js';
import { retryGoalTaskInputSchema } from '../features/mcp/goalTaskRetrySchemas.js';
import type { Goal } from '../infra/goals/schema.js';
import type { TaskState } from '../infra/task/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), states: vi.fn(), tasks: vi.fn(), exceeded: vi.fn(), ensure: vi.fn(), remove: vi.fn(), included: vi.fn(), sha: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.states; listAllTaskItems = doubles.tasks; listFailedTasks = doubles.tasks; requeueExceededTask = doubles.exceeded; } }));
vi.mock('../features/tasks/list/taskDeleteActions.js', () => ({ deleteTaskResources: doubles.remove }));
vi.mock('../infra/goals/git-command.js', () => ({ resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../features/manager/notifications.js', () => ({ resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }), sendSavedGoalNotifications: vi.fn() }));
vi.mock('../features/mcp/operations.js', async (original) => ({ ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: vi.fn() }));
let goal: Goal;
let state: TaskState;
const input = { cwd: '/project', goalId: goalRecord().id, taskName: 'task-a' };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks(); goal = goalRecord();
  state = { name: input.taskName, goalId: goal.id, kind: 'exceeded', status: 'exceeded', createdAt: '2026-10-14T00:00:00Z', filePath: '/project/.takt/tasks.yaml' };
  doubles.get.mockImplementation(async (id: string) => ({ ...goal, id }));
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => { goal = transform(goal); return goal; });
  doubles.states.mockImplementation(() => [state]);
  doubles.tasks.mockImplementation(() => [{ ...state, content: '元の指示', data: { task: '元の指示', start_step: 'implement', retry_note: '以前の注意' } }]);
  doubles.exceeded.mockImplementation(() => { state = { ...state, kind: 'pending', status: 'pending' }; });
  doubles.remove.mockReturnValue(true); doubles.included.mockResolvedValue(true); doubles.sha.mockResolvedValue('b'.repeat(40));
});
it('resumes exceeded work using its saved stop and does nothing on a repeated request', async () => {
  expect((await requeueTaktGoalTask({ ...input, retryNote: '追加の注意' }, {}, signal)).isError).toBeUndefined();
  expect(state.status).toBe('pending'); expect(doubles.exceeded).toHaveBeenCalledExactlyOnceWith('task-a', { retryNote: expect.stringContaining('追加の注意') });
  expect(goal.workLog).toHaveLength(1); expect(doubles.ensure).toHaveBeenCalledOnce();
  expect((await requeueTaktGoalTask(input, {}, signal)).isError).toBeUndefined(); expect(doubles.exceeded).toHaveBeenCalledOnce();
});
it.each(['pending', 'running', 'completed'] as const)('leaves a %s task unchanged on retry', async (status) => {
  state = { ...state, kind: status, status };
  expect((await retryTaktGoalTask({ ...input, task: '修正した指示' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.exceeded).not.toHaveBeenCalled(); expect(doubles.update).not.toHaveBeenCalled();
});
it('rejects another goal and invalid exceeded restart choices', async () => {
  expect((await requeueTaktGoalTask({ ...input, goalId: '550e8400-e29b-41d4-a716-446655440001' }, {}, signal)).isError).toBe(true);
  expect((await requeueTaktGoalTask({ ...input, startStep: 'other' }, {}, signal)).isError).toBe(true);
  expect(doubles.exceeded).not.toHaveBeenCalled();
});
it('removes stopped work with the existing task deletion function and records the reason', async () => {
  expect((await removeTaktGoalTask({ ...input, reason: '別の方法に変更' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledWith(expect.objectContaining({ name: 'task-a', kind: 'exceeded' }), { quiet: true, requireCleanupSuccess: true });
  expect(goal.workLog).toEqual([expect.objectContaining({ summary: expect.stringContaining('別の方法に変更') })]);
  doubles.states.mockReturnValue([]);
  expect((await removeTaktGoalTask({ ...input, reason: '別の方法に変更' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledOnce(); expect(goal.workLog).toHaveLength(1);
});
it.each(['running', 'unmerged', 'other goal'] as const)('rejects removal of %s work before resource deletion', async (condition) => {
  if (condition === 'running') state = { ...state, kind: 'running', status: 'running' };
  if (condition === 'other goal') state = { ...state, goalId: 'other' };
  if (condition === 'unmerged') { state = { ...state, kind: 'completed', status: 'completed', completion: { success: true, interrupted: false, sha: 'a'.repeat(40) } }; doubles.included.mockResolvedValue(false); }
  expect((await removeTaktGoalTask({ ...input, reason: '片付け' }, {}, signal)).isError).toBe(true); expect(doubles.remove).not.toHaveBeenCalled();
});
it('checks Git containment before cleaning up completed work', async () => {
  state = { ...state, kind: 'completed', status: 'completed', completion: { success: true, interrupted: false, sha: 'a'.repeat(40) } };
  expect((await removeTaktGoalTask({ ...input, reason: '取り込み済み' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.included).toHaveBeenCalledWith('/project', 'a'.repeat(40), 'b'.repeat(40), signal);
});
it('rejects the removed operationName argument rather than accepting legacy inputs', () => {
  expect(retryGoalTaskInputSchema.safeParse({ ...input, task: '修正', operationName: 'retry-a' }).success).toBe(false);
});
