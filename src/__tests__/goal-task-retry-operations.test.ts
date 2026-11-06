import { beforeEach,expect,it,vi } from 'vitest';
import { removeTaktGoalTask } from '../features/mcp/goalTaskRemovalOperations.js';
import { requeueTaktGoalTask,retryTaktGoalTask } from '../features/mcp/goalTaskRetryOperations.js';
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
  expect(goal.workLog).toHaveLength(1); expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
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
it.each(['failed', 'exceeded'] as const)('removes stopped %s work without a saved result and records the reason', async (status) => {
  state = { ...state, kind: status, status };
  expect((await removeTaktGoalTask({ ...input, reason: '別の方法に変更' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledWith(expect.objectContaining({ name: 'task-a', kind: status }), { quiet: true, requireCleanupSuccess: true });
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
it.each(['completed', 'pr_failed', 'failed', 'exceeded'] as const)('checks Git containment before cleaning up a saved %s result', async (status) => {
  state = { ...state, kind: status, status, completion: { success: status === 'completed', interrupted: false, sha: 'a'.repeat(40) } };
  expect((await removeTaktGoalTask({ ...input, reason: '取り込み済み' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.sha).toHaveBeenCalledExactlyOnceWith(input.cwd, goal.branch, signal);
  expect(doubles.included).toHaveBeenCalledWith('/project', 'a'.repeat(40), 'b'.repeat(40), signal);
  expect(doubles.remove).toHaveBeenCalledWith(expect.objectContaining({ name: input.taskName, kind: status }), { quiet: true, requireCleanupSuccess: true });
});

it('cancels pending work while its goal is paused and records the reason', async () => {
  goal.executionStatus = 'paused';
  state = { ...state, kind: 'pending', status: 'pending' };
  doubles.tasks.mockReturnValue([{ name: input.taskName, kind: 'pending', content: '予定作業' }]);
  expect((await removeTaktGoalTask({ ...input, reason: '不要になった予定を取消' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pending' }), { quiet: true, requireCleanupSuccess: true });
  expect(goal.executionStatus).toBe('paused');
  expect(goal.workLog.at(-1)!.summary).toContain('不要になった予定を取消');
});

it.each(['completed', 'pr_failed', 'failed', 'exceeded'] as const)('discards an unintegrated %s result only with an explicit discard flag', async (status) => {
  state = { ...state, kind: status, status, completion: { success: status === 'completed', interrupted: false, sha: 'a'.repeat(40) } };
  doubles.included.mockResolvedValue(false);
  expect((await removeTaktGoalTask({ ...input, reason: '不要な成果' }, {}, signal)).isError).toBe(true);
  expect((await removeTaktGoalTask({ ...input, reason: '不要な成果', discardUnmerged: false }, {}, signal)).isError).toBe(true);
  expect(doubles.remove).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
  expect((await removeTaktGoalTask({ ...input, reason: '人の破棄指示', discardUnmerged: true }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: input.taskName, kind: status }), { quiet: true, requireCleanupSuccess: true });
  expect(goal.workLog.at(-1)!.summary).toContain('discardUnmerged: true');
  expect(goal.workLog.at(-1)!.summary).toContain('人の破棄指示');
});

it.each([
  ['completed', undefined],
  ['pr_failed', undefined],
  ['failed', 'completed'],
] as const)('requires explicit discard for a %s result without a saved SHA (workflow: %s)', async (status, workflowResult) => {
  state = { ...state, kind: status, status, completion: { success: status === 'completed', interrupted: false, workflowResult, shaUnavailableReason: 'SHA unavailable' } };
  expect((await removeTaktGoalTask({ ...input, reason: '片付け' }, {}, signal)).isError).toBe(true);
  expect(doubles.included).not.toHaveBeenCalled();
  expect(doubles.remove).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
  expect((await removeTaktGoalTask({ ...input, reason: '人の破棄指示', discardUnmerged: true }, {}, signal)).isError).toBeUndefined();
  expect(doubles.remove).toHaveBeenCalledOnce();
  expect(goal.workLog.at(-1)!.summary).toContain('discardUnmerged: true');
});

it.each(['running', 'other goal', 'cleanup failure'] as const)('does not bypass %s with the discard flag', async (condition) => {
  if (condition === 'running') state = { ...state, kind: 'running', status: 'running' };
  if (condition === 'other goal') state = { ...state, goalId: 'other' };
  if (condition === 'cleanup failure') doubles.remove.mockReturnValue(false);
  expect((await removeTaktGoalTask({ ...input, reason: '片付け', discardUnmerged: true }, {}, signal)).isError).toBe(true);
  expect(goal.workLog).toHaveLength(0);
  if (condition !== 'cleanup failure') expect(doubles.remove).not.toHaveBeenCalled();
});

it('rejects a removal record exceeding the saved text limit before deleting resources', async () => {
  const result = await removeTaktGoalTask({ ...input, reason: 'x'.repeat(128 * 1024), discardUnmerged: true }, {}, signal);
  expect(result.isError).toBe(true);
  expect(doubles.remove).not.toHaveBeenCalled();
  expect(goal.workLog).toHaveLength(0);
});

it('requeues a goal PR task while the goal awaits merge', async () => {
  goal = { ...goal, status: 'awaiting_merge' };
  state = { ...state, mergeTask: true };
  expect((await requeueTaktGoalTask(input, {}, signal)).isError).toBeUndefined();
  expect(doubles.exceeded).toHaveBeenCalledOnce();
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
});
it.each(['pending', 'completed'] as const)('removes a %s PR merge task without treating it as unintegrated goal work', async (status) => {
  goal = { ...goal, status: 'awaiting_merge' };
  state = { ...state, kind: status, status, mergeTask: true,
    ...(status === 'completed' ? { completion: { success: true, interrupted: false, mergeOutcome: 'prepared' } } : {}) };
  expect((await removeTaktGoalTask({ ...input, reason: '仕上げタスクの片付け' }, {}, signal)).isError).toBeUndefined();
  expect(doubles.sha).not.toHaveBeenCalled();
  expect(doubles.included).not.toHaveBeenCalled();
  expect(doubles.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: input.taskName, kind: status }), { quiet: true, requireCleanupSuccess: true });
});
