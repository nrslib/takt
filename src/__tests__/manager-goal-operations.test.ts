import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeStep } from './test-helpers.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), enqueue: vi.fn(), validate: vi.fn(), list: vi.fn(), ensure: vi.fn() }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action() }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: vi.fn() }));
vi.mock('../infra/task/enqueueService.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/task/enqueueService.js')>(), enqueueTask: doubles.enqueue }));
vi.mock('../features/mcp/goalWorkflowValidation.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../features/mcp/goalWorkflowValidation.js')>(), validateGoalWorkflow: doubles.validate }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/config/index.js')>(), listWorkflows: doubles.list }));
import { GoalWorkflowNotAllowedError } from '../features/mcp/goalWorkflowValidation.js';
import { enqueueTaktGoalTask, listTaktWorkflows } from '../features/mcp/goalOperations.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { TaskRunner } from '../infra/task/runner.js';

let goal: Goal;
const input = { cwd: '/project', goalId: goalRecord().id, purpose: '検証を追加する', task: 'self-contained task', workflow: 'safe' };
const safeWorkflow: WorkflowConfig = { name: 'safe', description: 'safe description', steps: [makeStep({ name: 'work' })], initialStep: 'work', maxSteps: 4 };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => goal);
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
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
  expect(doubles.enqueue.mock.invocationCallOrder[0]).toBeLessThan(doubles.ensure.mock.invocationCallOrder[0]!);
});
it.each(['missing goal', 'forbidden workflow'] as const)('refuses success after %s fails', async (failure) => {
  if (failure === 'missing goal') doubles.get.mockRejectedValue(new Error('missing'));
  if (failure === 'forbidden workflow') doubles.validate.mockImplementation(() => { throw new Error('forbidden'); });
  expect((await enqueueTaktGoalTask(input, {}, new AbortController().signal)).isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
  expect(goal.workUnits).toBeUndefined();
  expect(doubles.ensure).not.toHaveBeenCalled();
});
it('reads workflow descriptions and refuses an unresolved listed workflow', () => {
  doubles.list.mockReturnValue(['safe']);
  doubles.validate.mockReturnValue(safeWorkflow);
  const result = listTaktWorkflows({ cwd: input.cwd }, {});
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ workflows: [{ name: 'safe', description: 'safe description' }] }) }]);
  doubles.validate.mockImplementation(() => { throw new Error('unresolved workflow'); });
  expect(listTaktWorkflows({ cwd: input.cwd }, {}).isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
});
it('excludes forbidden workflows and path identifiers from the listed goal candidates', () => {
  doubles.list.mockReturnValue(['safe', 'forbidden', 'work.yaml']);
  doubles.validate.mockImplementation((identifier: string) => {
    if (identifier !== 'safe') throw new GoalWorkflowNotAllowedError('not allowed');
    return safeWorkflow;
  });
  const result = listTaktWorkflows({ cwd: input.cwd }, {});
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '')).toEqual({
    workflows: [{ name: 'safe', description: 'safe description' }],
  });
  expect(doubles.validate.mock.calls).toEqual([
    ['safe', input.cwd], ['forbidden', input.cwd], ['work.yaml', input.cwd],
  ]);
  expect(doubles.enqueue).not.toHaveBeenCalled();
});

it('returns the saved task as a partial success when only goal recording fails', async () => {
  doubles.update.mockRejectedValue(new Error('failed publication'));
  const result = await enqueueTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '')).toMatchObject({
    taskName: 'actual-name-2', taskEnqueued: true, workUnitRecorded: false, workUnitRecordError: expect.any(String),
  });
  expect(doubles.enqueue).toHaveBeenCalledOnce();
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
  expect(goal.workUnits).toBeUndefined();
});
