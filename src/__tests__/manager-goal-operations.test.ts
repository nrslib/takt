import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), enqueue: vi.fn(), validate: vi.fn(), list: vi.fn(), load: vi.fn(), context: vi.fn() }));
vi.mock('../infra/goals/completion-evidence.js', () => ({ verifiedGoalCompletionContext: doubles.context }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/registration.js', () => ({ getRegisteredGoal: (_cwd: string, id: string) => doubles.get(id) }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action() }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: vi.fn() }));
vi.mock('../infra/task/enqueueService.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/task/enqueueService.js')>(), enqueueTask: doubles.enqueue }));
vi.mock('../features/mcp/goalWorkflowValidation.js', () => ({ validateGoalWorkflow: doubles.validate }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/config/index.js')>(), listWorkflows: doubles.list, loadWorkflowByIdentifier: doubles.load }));
import { enqueueTaktGoalTask, listTaktWorkflows, recordTaktGoalDecision } from '../features/mcp/goalOperations.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { enqueueGoalTaskInputSchema } from '../features/mcp/schemas.js';
import { TaskRunner } from '../infra/task/runner.js';

it('describes goal workflow selection as a manager decision and requires self-contained work instructions', () => {
  expect(enqueueGoalTaskInputSchema.shape.workflow.description).toBe('Workflow selected by the manager using takt_list_workflows names and descriptions.');
  expect(enqueueGoalTaskInputSchema.shape.task.description).toBe('Self-contained instructions for ready goal work. Do not request merging.');
});
let goal: Goal;
const input = { cwd: '/project', goalId: goalRecord().id, purpose: '検証を追加する', task: 'self-contained task', workflow: 'safe' };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => goal);
  doubles.context.mockImplementation((_cwd: string, goal: Goal) => ({ ...goal, events: [], sessions: [] }));
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); return goal; });
  doubles.enqueue.mockResolvedValue({ taskName: 'actual-name-2' });
});
afterEach(() => vi.restoreAllMocks());
it('exposes persisted goal ownership in task summaries and preserves ordinary task summaries', () => {
  vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockReturnValue([
    { name: 'goal-work', status: 'pending', goalId: goalRecord().id },
    { name: 'ordinary-work', status: 'pending' },
  ] as ReturnType<TaskRunner['listTaskStateItems']>);
  expect(listTaktTasks({ cwd: '/project' }).content).toEqual([{ type: 'text', text: JSON.stringify({ tasks: [
    { name: 'goal-work', goalId: goalRecord().id, status: 'pending' },
    { name: 'ordinary-work', status: 'pending' },
  ] }) }]);
});
it('fixes execution context in the common enqueue and records the name it actually returns', async () => {
  const result = await enqueueTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  expect(doubles.enqueue.mock.calls[0]![0]).toMatchObject({ goalId: goal.id, goalPurpose: input.purpose, taskContext: { baseBranch: goal.branch }, worktree: true, autoPr: false, shouldPublishBranchToOrigin: false });
  expect(goal.workUnits).toEqual([{ taskName: 'actual-name-2', purpose: input.purpose }]);
});
it.each(['missing goal', 'forbidden workflow', 'goal publication'] as const)('refuses success after %s fails', async (failure) => {
  if (failure === 'missing goal') doubles.get.mockRejectedValue(new Error('missing'));
  if (failure === 'forbidden workflow') doubles.validate.mockImplementation(() => { throw new Error('forbidden'); });
  if (failure === 'goal publication') doubles.update.mockRejectedValue(new Error('failed publication'));
  expect((await enqueueTaktGoalTask(input, {}, new AbortController().signal)).isError).toBe(true);
  expect(doubles.enqueue).toHaveBeenCalledTimes(failure === 'goal publication' ? 1 : 0);
  expect(goal.workUnits).toBeUndefined();
});
it('records a decision without changing goal completion or enqueueing work', async () => {
  expect((await recordTaktGoalDecision({ cwd: input.cwd, goalId: goal.id, decision: 'complete', reason: '条件を確認した' }, {})).isError).toBeUndefined();
  expect(goal.decisions).toEqual([expect.objectContaining({ decision: 'complete', reason: '条件を確認した' })]);
  expect(goal.status).toBe('created');
  expect(doubles.enqueue).not.toHaveBeenCalled();
});

it.each([true, false])('verifies decision response events only for manager operations: %s', async (manager) => {
  const event = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false }, processed: false };
  goal.events = [event];
  const result = await recordTaktGoalDecision({ cwd: input.cwd, goalId: goal.id, decision: 'complete', reason: 'reviewed' }, { registeredGoalsOnly: manager });
  expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '').goal.events).toEqual(manager ? [] : [event]);
  expect(doubles.context).toHaveBeenCalledTimes(manager ? 1 : 0);
  if (manager) expect(doubles.context).toHaveBeenCalledWith(input.cwd, goal);
  expect(goal.decisions).toHaveLength(1);
  expect(goal.status).toBe('created');
  expect(doubles.enqueue).not.toHaveBeenCalled();
});

it.each(['enqueue', 'decision'] as const)('rechecks registration inside the goal lock before %s', async (operation) => {
  doubles.get.mockResolvedValueOnce(goal).mockRejectedValueOnce(new Error('registration mismatch'));
  const result = operation === 'enqueue'
    ? await enqueueTaktGoalTask(input, {}, new AbortController().signal)
    : await recordTaktGoalDecision({ cwd: input.cwd, goalId: goal.id, decision: 'complete', reason: 'reviewed' }, {});
  expect(result.isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
  expect(doubles.update).not.toHaveBeenCalled();
});
it('reads workflow descriptions and refuses an unresolved listed workflow', () => {
  doubles.list.mockReturnValue(['safe']);
  doubles.load.mockReturnValue({ description: 'safe description' });
  const result = listTaktWorkflows({ cwd: input.cwd }, {});
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ workflows: [{ name: 'safe', description: 'safe description' }] }) }]);
  doubles.load.mockReturnValue(null);
  expect(listTaktWorkflows({ cwd: input.cwd }, {}).isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
});
